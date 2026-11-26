import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { getCases, validProgress } from './problems.mjs';

const publicFields = `id, participant, problem, attempts, created_at AS createdAt,
  finished_at AS finishedAt, worker, detail, status, expires AS _expires, lease AS _lease,
  phase, tests_completed AS testsCompleted, tests_total AS testsTotal`;

function publicSubmission(row, now, maxAttempts) {
  if (!row) return undefined;
  const attempts = Number(row.attempts);
  const expired = row.status === 'running' && Number(row._expires) <= now;
  return {
    id: row.id,
    participant: row.participant,
    problem: row.problem,
    attempts,
    createdAt: Number(row.createdAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
    worker: expired ? null : row.worker,
    detail: row.detail,
    status: expired ? (attempts >= maxAttempts ? 'dead_letter' : 'queued') : row.status,
    phase: expired ? null : row.phase,
    testsCompleted: expired ? 0 : Number(row.testsCompleted),
    testsTotal: Number(row.testsTotal),
    expires: expired || row.status !== 'running' ? null : Number(row._expires),
    leasePrefix: expired || !row._lease ? null : String(row._lease).slice(0, 8),
  };
}

function eventRow(row) {
  return {
    id: Number(row.id),
    createdAt: Number(row.createdAt),
    type: row.type,
    submissionId: row.submissionId,
    worker: row.worker,
    leasePrefix: row.leasePrefix,
    attempt: row.attempt === null ? null : Number(row.attempt),
    detail: row.detail,
  };
}

export function createTursoStore({ url, authToken, leaseMs, maxAttempts = 3 }) {
  const client = createClient({ url, authToken });
  let ready = null;

  function ensureReady() {
    if (!ready) {
      ready = (async () => {
        await client.batch([
          `CREATE TABLE IF NOT EXISTS submissions (
            id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
            source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
            expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
            phase TEXT, tests_completed INTEGER NOT NULL DEFAULT 0, tests_total INTEGER NOT NULL DEFAULT 0,
            first_claimed_at INTEGER, claimed_at INTEGER
          )`,
          'CREATE INDEX IF NOT EXISTS submissions_queue ON submissions(status, created_at)',
          'CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)',
          `CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            type TEXT NOT NULL,
            submission_id TEXT,
            worker TEXT,
            lease_prefix TEXT,
            attempt INTEGER,
            detail TEXT
          )`,
          'CREATE INDEX IF NOT EXISTS events_created ON events(created_at DESC, id DESC)',
        ], 'write');
        const info = await client.execute('PRAGMA table_info(submissions)');
        const columns = new Set(info.rows.map((row) => row.name));
        const migrations = [];
        for (const [name, definition] of [['first_claimed_at', 'INTEGER'], ['claimed_at', 'INTEGER']]) {
          if (!columns.has(name)) migrations.push(`ALTER TABLE submissions ADD COLUMN ${name} ${definition}`);
        }
        if (migrations.length) await client.batch(migrations, 'write');
      })().catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  function eventInsert(now, type, submissionId, worker, lease, attempt, detail) {
    return {
      sql: `INSERT INTO events (created_at, type, submission_id, worker, lease_prefix, attempt, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [now, type, submissionId ?? null, worker ?? null, lease ? String(lease).slice(0, 8) : null, attempt ?? null, detail ?? null],
    };
  }

  async function sweepDeadLetters(now) {
    const detail = `Limite de ${maxAttempts} tentativas atingido após expiração de reserva`;
    const res = await client.execute({
      sql: `UPDATE submissions SET
        status = 'dead_letter', finished_at = ?, expires = NULL, detail = ?
        WHERE status = 'running' AND expires <= ? AND attempts >= ?
        RETURNING id, worker, lease, attempts`,
      args: [now, detail, now, maxAttempts],
    });
    if (res.rows.length) {
      await client.batch(
        res.rows.map((row) => eventInsert(now, 'dead_letter', row.id, row.worker, row.lease, Number(row.attempts), detail)),
        'write',
      );
    }
  }

  return {
    async get(id) {
      await ensureReady();
      const res = await client.execute({
        sql: `SELECT ${publicFields} FROM submissions WHERE id = ?`,
        args: [id],
      });
      return publicSubmission(res.rows[0], Date.now(), maxAttempts);
    },

    async submit({ participant, problem, source }) {
      await ensureReady();
      const id = randomUUID();
      const now = Date.now();
      const [, , getRes] = await client.batch([
        {
          sql: 'INSERT INTO submissions (id, participant, problem, source, created_at, tests_total) VALUES (?, ?, ?, ?, ?, ?)',
          args: [id, participant, problem, source, now, getCases(problem).length],
        },
        eventInsert(now, 'submitted', id, null, null, 0, `${participant} · Problema ${problem}`),
        {
          sql: `SELECT ${publicFields} FROM submissions WHERE id = ?`,
          args: [id],
        },
      ], 'write');
      return publicSubmission(getRes.rows[0], now, maxAttempts);
    },

    async dashboard() {
      await ensureReady();
      const now = Date.now();
      await sweepDeadLetters(now);
      const [countsRes, timingRes, evMetricsRes, listRes, activeRes, recentRes, workersRes, eventsRes] = await client.batch([
        {
          sql: `SELECT
            COUNT(*) AS total,
            COUNT(CASE WHEN status = 'queued' OR (status = 'running' AND expires <= ? AND attempts < ?) THEN 1 END) AS queued,
            COUNT(CASE WHEN status = 'running' AND expires > ? THEN 1 END) AS running,
            COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted,
            COUNT(CASE WHEN status = 'dead_letter' THEN 1 END) AS deadLetter
            FROM submissions`,
          args: [now, maxAttempts, now],
        },
        {
          sql: `SELECT
            ROUND(AVG(CASE WHEN first_claimed_at IS NOT NULL THEN first_claimed_at - created_at END)) AS avgQueueMs,
            ROUND(AVG(CASE WHEN finished_at IS NOT NULL AND claimed_at IS NOT NULL AND status != 'dead_letter' THEN finished_at - claimed_at END)) AS avgExecMs
            FROM submissions`,
          args: [],
        },
        {
          sql: `SELECT
            COUNT(CASE WHEN type = 'reclaimed' THEN 1 END) AS reclaims,
            COUNT(CASE WHEN type = 'stale_rejected' THEN 1 END) AS staleRejections,
            COUNT(CASE WHEN type = 'idempotent_replay' THEN 1 END) AS idempotentReplays
            FROM events`,
          args: [],
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
        {
          sql: `SELECT id, created_at AS createdAt, type, submission_id AS submissionId,
            worker, lease_prefix AS leasePrefix, attempt, detail FROM events ORDER BY id DESC LIMIT 30`,
          args: [],
        },
      ], 'read');
      const countsRow = countsRes.rows[0];
      const timingRow = timingRes.rows[0];
      const evRow = evMetricsRes.rows[0];
      const deadLetter = Number(countsRow.deadLetter);
      return {
        serverTime: now,
        config: { leaseMs, maxAttempts },
        counts: {
          total: Number(countsRow.total),
          queued: Number(countsRow.queued),
          running: Number(countsRow.running),
          accepted: Number(countsRow.accepted),
          deadLetter,
        },
        metrics: {
          avgQueueMs: timingRow.avgQueueMs === null ? null : Number(timingRow.avgQueueMs),
          avgExecMs: timingRow.avgExecMs === null ? null : Number(timingRow.avgExecMs),
          reclaims: Number(evRow.reclaims),
          staleRejections: Number(evRow.staleRejections),
          idempotentReplays: Number(evRow.idempotentReplays),
          deadLetters: deadLetter,
        },
        submissions: listRes.rows.map((row) => publicSubmission(row, now, maxAttempts)),
        activeSubmissions: activeRes.rows.map((row) => publicSubmission(row, now, maxAttempts)),
        recentResults: recentRes.rows.map((row) => publicSubmission(row, now, maxAttempts)),
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
        events: eventsRes.rows.map(eventRow),
      };
    },

    async claim(worker) {
      await ensureReady();
      const now = Date.now();
      await sweepDeadLetters(now);
      const [, claimRes] = await client.batch([
        {
          sql: `INSERT INTO workers VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
          args: [worker, now],
        },
        {
          sql: `UPDATE submissions SET
            status = 'running', worker = ?, lease = ?, expires = ?, attempts = attempts + 1,
            phase = NULL, tests_completed = 0,
            first_claimed_at = COALESCE(first_claimed_at, ?), claimed_at = ?
            WHERE id = (SELECT id FROM submissions WHERE status = 'queued' OR
              (status = 'running' AND expires <= ? AND attempts < ?) ORDER BY created_at, rowid LIMIT 1)
            RETURNING id, problem, source, lease, attempts`,
          args: [worker, randomUUID(), now + leaseMs, now, now, now, maxAttempts],
        },
      ], 'write');
      const row = claimRes.rows[0];
      if (!row) return undefined;
      const attempts = Number(row.attempts);
      await client.execute(eventInsert(
        now,
        attempts > 1 ? 'reclaimed' : 'claimed',
        row.id,
        worker,
        row.lease,
        attempts,
        attempts > 1 ? `Retomada após expiração (tentativa ${attempts})` : `Problema ${row.problem}`,
      ));
      return {
        id: row.id,
        problem: row.problem,
        source: row.source,
        lease: row.lease,
        attempts,
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
        return true;
      }
      const prior = await client.execute({
        sql: 'SELECT status, lease, worker, attempts FROM submissions WHERE id = ?',
        args: [id],
      });
      const saved = prior.rows[0];
      if (saved && (saved.status === 'running' || saved.lease !== lease)) {
        await client.execute(eventInsert(
          now, 'stale_rejected', id, saved.lease === lease ? saved.worker : null, lease, Number(saved.attempts), 'renew rejeitado (409)',
        ));
      }
      return false;
    },

    async finish(id, { lease, status, detail }) {
      await ensureReady();
      const now = Date.now();
      const res = await client.execute({
        sql: `UPDATE submissions SET status = ?, detail = ?, finished_at = ?, expires = NULL
          WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?
          RETURNING worker, attempts`,
        args: [status, detail ?? null, now, id, lease, now],
      });
      const finished = res.rows[0];
      if (finished) {
        await client.execute(eventInsert(now, 'finished', id, finished.worker, lease, Number(finished.attempts), status));
        return true;
      }
      const prior = await client.execute({
        sql: 'SELECT status, lease, worker, attempts FROM submissions WHERE id = ?',
        args: [id],
      });
      const saved = prior.rows[0];
      if (saved?.lease === lease && saved?.status === status) {
        await client.execute(eventInsert(now, 'idempotent_replay', id, saved.worker, lease, Number(saved.attempts), `${status} (idempotente)`));
        return true;
      }
      await client.execute(eventInsert(
        now, 'stale_rejected', id, saved?.lease === lease ? saved.worker : null, lease, saved ? Number(saved.attempts) : null, 'finish rejeitado (409)',
      ));
      return false;
    },
  };
}
