import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getCases, problems, validProgress } from './problems.mjs';

export const verdicts = ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'judge_error'];

const publicFields = `id, participant, problem, attempts, created_at AS createdAt,
  finished_at AS finishedAt, worker, detail, status, expires AS _expires,
  phase, tests_completed AS testsCompleted, tests_total AS testsTotal`;

function publicSubmission(row, now) {
  if (!row) return row;
  const { _expires, ...result } = row;
  if (result.status === 'running' && _expires <= now) {
    Object.assign(result, { status: 'queued', worker: null, phase: null, testsCompleted: 0 });
  }
  return result;
}

export function createStore(path, leaseMs) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
      expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
      phase TEXT, tests_completed INTEGER NOT NULL DEFAULT 0, tests_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS submissions_queue ON submissions(status, created_at);
    CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
  `);
  // Existing local databases keep their submissions when progress is introduced.
  const columns = new Set(db.prepare('PRAGMA table_info(submissions)').all().map(({ name }) => name));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, definition] of [
      ['phase', 'TEXT'], ['tests_completed', 'INTEGER NOT NULL DEFAULT 0'], ['tests_total', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE submissions ADD COLUMN ${name} ${definition}`);
    }
    const totals = db.prepare('UPDATE submissions SET tests_total = ? WHERE problem = ? AND tests_total = 0');
    for (const problem of problems) totals.run(getCases(problem.id).length, problem.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const get = db.prepare(`SELECT ${publicFields} FROM submissions WHERE id = ?`);
  const list = db.prepare(`SELECT ${publicFields} FROM submissions ORDER BY created_at DESC, rowid DESC LIMIT 50`);
  const active = db.prepare(`SELECT ${publicFields} FROM submissions WHERE status IN ('queued', 'running')
    ORDER BY CASE WHEN status = 'running' AND expires > ? THEN 0 ELSE 1 END, created_at, rowid LIMIT 100`);
  const recentResults = db.prepare(`SELECT ${publicFields} FROM submissions
    WHERE status NOT IN ('queued', 'running') AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, rowid DESC LIMIT 10`);
  const insert = db.prepare('INSERT INTO submissions (id, participant, problem, source, created_at, tests_total) VALUES (?, ?, ?, ?, ?, ?)');
  const heartbeat = db.prepare(`INSERT INTO workers VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`);
  const workers = db.prepare(`SELECT id, last_seen AS lastSeen,
    EXISTS (SELECT 1 FROM submissions WHERE worker = workers.id AND status = 'running' AND expires > ?) AS busy
    FROM (SELECT * FROM workers WHERE last_seen >= ? ORDER BY last_seen DESC, id LIMIT 50) AS workers
    ORDER BY id`);
  const counts = db.prepare(`SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN status = 'queued' OR (status = 'running' AND expires <= ?) THEN 1 END) AS queued,
    COUNT(CASE WHEN status = 'running' AND expires > ? THEN 1 END) AS running,
    COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted
    FROM submissions`);
  const claim = db.prepare(`UPDATE submissions SET
    status = 'running', worker = ?, lease = ?, expires = ?, attempts = attempts + 1,
    phase = NULL, tests_completed = 0
    WHERE id = (SELECT id FROM submissions WHERE status = 'queued' OR
      (status = 'running' AND expires <= ?) ORDER BY created_at, rowid LIMIT 1)
    RETURNING id, problem, source, lease, attempts`);
  const renew = db.prepare(`UPDATE submissions SET expires = ?
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ? RETURNING worker`);
  const progress = db.prepare(`UPDATE submissions SET expires = ?, phase = ?, tests_completed = ?
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?
      AND tests_completed <= ? AND (phase IS NULL OR phase = 'compiling' OR ? = 'testing') RETURNING worker`);
  const finish = db.prepare(`UPDATE submissions SET status = ?, detail = ?, finished_at = ?, expires = NULL
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?`);
  const prior = db.prepare('SELECT status, lease FROM submissions WHERE id = ?');

  return {
    get(id) { return publicSubmission(get.get(id), Date.now()); },
    submit({ participant, problem, source }) {
      const id = randomUUID();
      const now = Date.now();
      insert.run(id, participant, problem, source, now, getCases(problem).length);
      return publicSubmission(get.get(id), now);
    },
    dashboard() {
      const now = Date.now();
      return {
        counts: counts.get(now, now), submissions: list.all().map((row) => publicSubmission(row, now)),
        activeSubmissions: active.all(now).map((row) => publicSubmission(row, now)),
        recentResults: recentResults.all().map((row) => publicSubmission(row, now)),
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
    renew(id, lease, update) {
      const now = Date.now();
      if (update !== undefined && !validProgress(update, get.get(id)?.problem)) return false;
      const job = update === undefined ? renew.get(now + leaseMs, id, lease, now)
        : progress.get(now + leaseMs, update.phase, update.testsCompleted, id, lease, now, update.testsCompleted, update.phase);
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
