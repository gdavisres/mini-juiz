import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { getCases, validProgress } from './problems.mjs';

const publicFields = `id, participant, problem, attempts, created_at AS createdAt,
  finished_at AS finishedAt, worker, detail, status, expires AS _expires,
  phase, tests_completed AS testsCompleted, tests_total AS testsTotal`;

function publicSubmission(row, now) {
  if (!row) return undefined;
  const expired = row.status === 'running' && Number(row._expires) <= now;
  return {
    id: row.id,
    participant: row.participant,
    problem: row.problem,
    attempts: Number(row.attempts),
    createdAt: Number(row.createdAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
    worker: expired ? null : row.worker,
    detail: row.detail,
    status: expired ? 'queued' : row.status,
    phase: expired ? null : row.phase,
    testsCompleted: expired ? 0 : Number(row.testsCompleted),
    testsTotal: Number(row.testsTotal),
  };
}

export function createTursoStore({ url, authToken, leaseMs }) {
  const client = createClient({ url, authToken });
  let ready = null;

  function ensureReady() {
    if (!ready) {
      ready = client.batch([
        `CREATE TABLE IF NOT EXISTS submissions (
          id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
          source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
          expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
          phase TEXT, tests_completed INTEGER NOT NULL DEFAULT 0, tests_total INTEGER NOT NULL DEFAULT 0
        )`,
        'CREATE INDEX IF NOT EXISTS submissions_queue ON submissions(status, created_at)',
        'CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)',
      ], 'write').catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  return {
    async get(id) {
      await ensureReady();
      const res = await client.execute({
        sql: `SELECT ${publicFields} FROM submissions WHERE id = ?`,
        args: [id],
      });
      return publicSubmission(res.rows[0], Date.now());
    },

    async submit({ participant, problem, source }) {
      await ensureReady();
      const id = randomUUID();
      const now = Date.now();
      const [, getRes] = await client.batch([
        {
          sql: 'INSERT INTO submissions (id, participant, problem, source, created_at, tests_total) VALUES (?, ?, ?, ?, ?, ?)',
          args: [id, participant, problem, source, now, getCases(problem).length],
        },
        {
          sql: `SELECT ${publicFields} FROM submissions WHERE id = ?`,
          args: [id],
        },
      ], 'write');
      return publicSubmission(getRes.rows[0], now);
    },

    async dashboard() {
      await ensureReady();
      const now = Date.now();
      const [countsRes, listRes, activeRes, recentRes, workersRes] = await client.batch([
        {
          sql: `SELECT
            COUNT(*) AS total,
            COUNT(CASE WHEN status = 'queued' OR (status = 'running' AND expires <= ?) THEN 1 END) AS queued,
            COUNT(CASE WHEN status = 'running' AND expires > ? THEN 1 END) AS running,
            COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted
            FROM submissions`,
          args: [now, now],
        },
        {
          sql: `SELECT ${publicFields} FROM submissions ORDER BY created_at DESC, rowid DESC LIMIT 50`,
          args: [],
        },
        {
          sql: `SELECT ${publicFields} FROM submissions WHERE status IN ('queued', 'running')
            ORDER BY CASE WHEN status = 'running' AND expires > ? THEN 0 ELSE 1 END, created_at, rowid LIMIT 100`,
          args: [now],
        },
        {
          sql: `SELECT ${publicFields} FROM submissions
            WHERE status NOT IN ('queued', 'running') AND finished_at IS NOT NULL
            ORDER BY finished_at DESC, rowid DESC LIMIT 10`,
          args: [],
        },
        {
          sql: `SELECT id, last_seen AS lastSeen,
            EXISTS (SELECT 1 FROM submissions WHERE worker = workers.id AND status = 'running' AND expires > ?) AS busy
            FROM (SELECT * FROM workers WHERE last_seen >= ? ORDER BY last_seen DESC, id LIMIT 50) AS workers
            ORDER BY id`,
          args: [now, now - 86400000],
        },
      ], 'read');
      const countsRow = countsRes.rows[0];
      return {
        counts: {
          total: Number(countsRow.total),
          queued: Number(countsRow.queued),
          running: Number(countsRow.running),
          accepted: Number(countsRow.accepted),
        },
        submissions: listRes.rows.map((row) => publicSubmission(row, now)),
        activeSubmissions: activeRes.rows.map((row) => publicSubmission(row, now)),
        recentResults: recentRes.rows.map((row) => publicSubmission(row, now)),
        workers: workersRes.rows.map((worker) => {
          const lastSeen = Number(worker.lastSeen);
          const busy = Number(worker.busy);
          return {
            id: worker.id,
            lastSeen,
            busy,
            status: lastSeen < now - 5000 ? 'offline' : busy ? 'busy' : 'online',
          };
        }),
      };
    },

    async claim(worker) {
      await ensureReady();
      const now = Date.now();
      const [, claimRes] = await client.batch([
        {
          sql: `INSERT INTO workers VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
          args: [worker, now],
        },
        {
          sql: `UPDATE submissions SET
            status = 'running', worker = ?, lease = ?, expires = ?, attempts = attempts + 1,
            phase = NULL, tests_completed = 0
            WHERE id = (SELECT id FROM submissions WHERE status = 'queued' OR
              (status = 'running' AND expires <= ?) ORDER BY created_at, rowid LIMIT 1)
            RETURNING id, problem, source, lease, attempts`,
          args: [worker, randomUUID(), now + leaseMs, now],
        },
      ], 'write');
      const row = claimRes.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        problem: row.problem,
        source: row.source,
        lease: row.lease,
        attempts: Number(row.attempts),
        leaseMs,
      };
    },

    async renew(id, lease, update) {
      await ensureReady();
      const now = Date.now();
      if (update !== undefined) {
        const current = await client.execute({
          sql: 'SELECT problem FROM submissions WHERE id = ?',
          args: [id],
        });
        if (!validProgress(update, current.rows[0]?.problem)) return false;
      }
      const res = update === undefined
        ? await client.execute({
          sql: `UPDATE submissions SET expires = ?
            WHERE id = ? AND lease = ? AND status = 'running' AND expires > ? RETURNING worker`,
          args: [now + leaseMs, id, lease, now],
        })
        : await client.execute({
          sql: `UPDATE submissions SET expires = ?, phase = ?, tests_completed = ?
            WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?
              AND tests_completed <= ? AND (phase IS NULL OR phase = 'compiling' OR ? = 'testing') RETURNING worker`,
          args: [now + leaseMs, update.phase, update.testsCompleted, id, lease, now, update.testsCompleted, update.phase],
        });
      const job = res.rows[0];
      if (job) {
        await client.execute({
          sql: `INSERT INTO workers VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
          args: [job.worker, now],
        });
      }
      return Boolean(job);
    },

    async finish(id, { lease, status, detail }) {
      await ensureReady();
      const now = Date.now();
      const res = await client.execute({
        sql: `UPDATE submissions SET status = ?, detail = ?, finished_at = ?, expires = NULL
          WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?`,
        args: [status, detail ?? null, now, id, lease, now],
      });
      if (res.rowsAffected > 0) return true;
      const prior = await client.execute({
        sql: 'SELECT status, lease FROM submissions WHERE id = ?',
        args: [id],
      });
      const saved = prior.rows[0];
      return saved?.lease === lease && saved?.status === status;
    },
  };
}
