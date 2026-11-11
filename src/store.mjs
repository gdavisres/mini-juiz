import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const verdicts = ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'judge_error'];

const publicFields = `id, participant, problem, attempts, created_at AS createdAt,
  finished_at AS finishedAt, worker, detail,
  CASE WHEN status = 'running' AND expires <= ? THEN 'queued' ELSE status END AS status`;

export function createStore(path, leaseMs) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
      expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS submissions_queue ON submissions(status, created_at);
    CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
  `);
  const get = db.prepare(`SELECT ${publicFields} FROM submissions WHERE id = ?`);
  const list = db.prepare(`SELECT ${publicFields} FROM submissions ORDER BY created_at DESC, rowid DESC LIMIT 50`);
  const insert = db.prepare('INSERT INTO submissions (id, participant, problem, source, created_at) VALUES (?, ?, ?, ?, ?)');
  const heartbeat = db.prepare(`INSERT INTO workers VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`);
  const workers = db.prepare(`SELECT id, last_seen AS lastSeen,
    EXISTS (SELECT 1 FROM submissions WHERE worker = workers.id AND status = 'running' AND expires > ?) AS busy
    FROM workers WHERE last_seen >= ? ORDER BY last_seen DESC, id LIMIT 50`);
  const counts = db.prepare(`SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN status = 'queued' OR (status = 'running' AND expires <= ?) THEN 1 END) AS queued,
    COUNT(CASE WHEN status = 'running' AND expires > ? THEN 1 END) AS running,
    COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted
    FROM submissions`);
  const claim = db.prepare(`UPDATE submissions SET
    status = 'running', worker = ?, lease = ?, expires = ?, attempts = attempts + 1
    WHERE id = (SELECT id FROM submissions WHERE status = 'queued' OR
      (status = 'running' AND expires <= ?) ORDER BY created_at, rowid LIMIT 1)
    RETURNING id, problem, source, lease, attempts`);
  const renew = db.prepare(`UPDATE submissions SET expires = ?
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ? RETURNING worker`);
  const finish = db.prepare(`UPDATE submissions SET status = ?, detail = ?, finished_at = ?, expires = NULL
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?`);
  const prior = db.prepare('SELECT status, lease FROM submissions WHERE id = ?');

  return {
    get(id) { return get.get(Date.now(), id); },
    submit({ participant, problem, source }) {
      const id = randomUUID();
      const now = Date.now();
      insert.run(id, participant, problem, source, now);
      return get.get(now, id);
    },
    dashboard() {
      const now = Date.now();
      return {
        counts: counts.get(now, now), submissions: list.all(now),
        workers: workers.all(now, now - 86400000).map((worker) => ({
          ...worker, status: worker.lastSeen < now - 5000 ? 'offline' : worker.busy ? 'busy' : 'online',
        })),
      };
    },
    claim(worker) {
      const now = Date.now();
      heartbeat.run(worker, now);
      const job = claim.get(worker, randomUUID(), now + leaseMs, now);
      return job && { ...job, leaseMs };
    },
    renew(id, lease) {
      const now = Date.now();
      const job = renew.get(now + leaseMs, id, lease, now);
      if (job) heartbeat.run(job.worker, now);
      return Boolean(job);
    },
    finish(id, { lease, status, detail }) {
      const now = Date.now();
      if (finish.run(status, detail, now, id, lease, now).changes) return true;
      const saved = prior.get(id);
      return saved?.lease === lease && saved.status === status;
    },
  };
}
