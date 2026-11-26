import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getCases, problems, validProgress } from './problems.mjs';

export const verdicts = ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'judge_error'];

const publicFields = `id, participant, problem, attempts, created_at AS createdAt,
  finished_at AS finishedAt, worker, detail, status, expires AS _expires, lease AS _lease,
  phase, tests_completed AS testsCompleted, tests_total AS testsTotal,
  test_results AS _testResults, last_renewed_at AS lastRenewedAt`;

function parseTestResults(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicSubmission(row, now, maxAttempts) {
  if (!row) return row;
  const { _expires, _lease, _testResults, ...result } = row;
  if (result.status === 'running' && _expires <= now) {
    Object.assign(result, {
      status: result.attempts >= maxAttempts ? 'dead_letter' : 'queued',
      worker: null, phase: null, testsCompleted: 0, expires: null, leasePrefix: null,
      testResults: [], lastRenewedAt: null,
    });
    return result;
  }
  result.expires = result.status === 'running' ? _expires : null;
  result.leasePrefix = _lease ? _lease.slice(0, 8) : null;
  result.testResults = parseTestResults(_testResults);
  result.lastRenewedAt = result.lastRenewedAt ?? null;
  return result;
}

export function createStore(path, leaseMs, maxAttempts = 3) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
      expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
      phase TEXT, tests_completed INTEGER NOT NULL DEFAULT 0, tests_total INTEGER NOT NULL DEFAULT 0,
      first_claimed_at INTEGER, claimed_at INTEGER,
      test_results TEXT, last_renewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS submissions_queue ON submissions(status, created_at);
    CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      type TEXT NOT NULL,
      submission_id TEXT,
      worker TEXT,
      lease_prefix TEXT,
      attempt INTEGER,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS events_created ON events(created_at DESC, id DESC);
  `);
  // Existing local databases keep their submissions when new columns are introduced.
  const columns = new Set(db.prepare('PRAGMA table_info(submissions)').all().map(({ name }) => name));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, definition] of [
      ['phase', 'TEXT'], ['tests_completed', 'INTEGER NOT NULL DEFAULT 0'], ['tests_total', 'INTEGER NOT NULL DEFAULT 0'],
      ['first_claimed_at', 'INTEGER'], ['claimed_at', 'INTEGER'],
      ['test_results', 'TEXT'], ['last_renewed_at', 'INTEGER'],
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
  const insertEvent = db.prepare(`INSERT INTO events (created_at, type, submission_id, worker, lease_prefix, attempt, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const listEvents = db.prepare(`SELECT id, created_at AS createdAt, type, submission_id AS submissionId,
    worker, lease_prefix AS leasePrefix, attempt, detail FROM events ORDER BY id DESC LIMIT 30`);
  const heartbeat = db.prepare(`INSERT INTO workers VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`);
  const workers = db.prepare(`SELECT id, last_seen AS lastSeen,
    EXISTS (SELECT 1 FROM submissions WHERE worker = workers.id AND status = 'running' AND expires > ?) AS busy
    FROM (SELECT * FROM workers WHERE last_seen >= ? ORDER BY last_seen DESC, id LIMIT 50) AS workers
    ORDER BY id`);
  const counts = db.prepare(`SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN status = 'queued' OR (status = 'running' AND expires <= ? AND attempts < ?) THEN 1 END) AS queued,
    COUNT(CASE WHEN status = 'running' AND expires > ? THEN 1 END) AS running,
    COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted,
    COUNT(CASE WHEN status = 'dead_letter' THEN 1 END) AS deadLetter
    FROM submissions`);
  const timingMetrics = db.prepare(`SELECT
    ROUND(AVG(CASE WHEN first_claimed_at IS NOT NULL THEN first_claimed_at - created_at END)) AS avgQueueMs,
    ROUND(AVG(CASE WHEN finished_at IS NOT NULL AND claimed_at IS NOT NULL AND status != 'dead_letter' THEN finished_at - claimed_at END)) AS avgExecMs
    FROM submissions`);
  const eventMetrics = db.prepare(`SELECT
    COUNT(CASE WHEN type = 'reclaimed' THEN 1 END) AS reclaims,
    COUNT(CASE WHEN type = 'stale_rejected' THEN 1 END) AS staleRejections,
    COUNT(CASE WHEN type = 'idempotent_replay' THEN 1 END) AS idempotentReplays
    FROM events`);
  const promoteDeadLetters = db.prepare(`UPDATE submissions SET
    status = 'dead_letter', finished_at = ?, expires = NULL, detail = ?
    WHERE status = 'running' AND expires <= ? AND attempts >= ?
    RETURNING id, worker, lease, attempts`);
  const claim = db.prepare(`UPDATE submissions SET
    status = 'running', worker = ?, lease = ?, expires = ?, attempts = attempts + 1,
    phase = NULL, tests_completed = 0, test_results = NULL, last_renewed_at = NULL,
    first_claimed_at = COALESCE(first_claimed_at, ?), claimed_at = ?
    WHERE id = (SELECT id FROM submissions WHERE status = 'queued' OR
      (status = 'running' AND expires <= ? AND attempts < ?) ORDER BY created_at, rowid LIMIT 1)
    RETURNING id, problem, source, lease, attempts`);
  const renew = db.prepare(`UPDATE submissions SET expires = ?, last_renewed_at = ?
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ? RETURNING worker`);
  const progress = db.prepare(`UPDATE submissions SET expires = ?, last_renewed_at = ?, phase = ?, tests_completed = ?,
    test_results = COALESCE(?, test_results)
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ?
      AND tests_completed <= ? AND (phase IS NULL OR phase = 'compiling' OR ? = 'testing') RETURNING worker`);
  const finish = db.prepare(`UPDATE submissions SET status = ?, detail = ?, finished_at = ?, expires = NULL
    WHERE id = ? AND lease = ? AND status = 'running' AND expires > ? RETURNING worker, attempts`);
  const prior = db.prepare('SELECT status, lease, worker, attempts FROM submissions WHERE id = ?');

  function logEvent(now, type, submissionId, worker, lease, attempt, detail) {
    insertEvent.run(now, type, submissionId ?? null, worker ?? null, lease ? lease.slice(0, 8) : null, attempt ?? null, detail ?? null);
  }

  function sweepDeadLetters(now) {
    const detail = `Limite de ${maxAttempts} tentativas atingido após expiração de reserva`;
    const promoted = promoteDeadLetters.all(now, detail, now, maxAttempts);
    for (const row of promoted) {
      logEvent(now, 'dead_letter', row.id, row.worker, row.lease, row.attempts, detail);
    }
  }

  return {
    get(id) { return publicSubmission(get.get(id), Date.now(), maxAttempts); },
    submit({ participant, problem, source }) {
      const id = randomUUID();
      const now = Date.now();
      insert.run(id, participant, problem, source, now, getCases(problem).length);
      logEvent(now, 'submitted', id, null, null, 0, `${participant} · Problema ${problem}`);
      return publicSubmission(get.get(id), now, maxAttempts);
    },
    dashboard() {
      const now = Date.now();
      sweepDeadLetters(now);
      const countRow = counts.get(now, maxAttempts, now);
      const timing = timingMetrics.get();
      const evCounts = eventMetrics.get();
      return {
        serverTime: now,
        config: { leaseMs, maxAttempts },
        counts: countRow,
        metrics: {
          avgQueueMs: timing.avgQueueMs ?? null,
          avgExecMs: timing.avgExecMs ?? null,
          reclaims: evCounts.reclaims,
          staleRejections: evCounts.staleRejections,
          idempotentReplays: evCounts.idempotentReplays,
          deadLetters: countRow.deadLetter,
        },
        submissions: list.all().map((row) => publicSubmission(row, now, maxAttempts)),
        activeSubmissions: active.all(now).map((row) => publicSubmission(row, now, maxAttempts)),
        recentResults: recentResults.all().map((row) => publicSubmission(row, now, maxAttempts)),
        workers: workers.all(now, now - 86400000).map((worker) => ({
          ...worker, status: worker.lastSeen < now - 5000 ? 'offline' : worker.busy ? 'busy' : 'online',
        })),
        events: listEvents.all(),
      };
    },
    claim(worker) {
      const now = Date.now();
      heartbeat.run(worker, now);
      sweepDeadLetters(now);
      const job = claim.get(worker, randomUUID(), now + leaseMs, now, now, now, maxAttempts);
      if (job) {
        logEvent(
          now,
          job.attempts > 1 ? 'reclaimed' : 'claimed',
          job.id,
          worker,
          job.lease,
          job.attempts,
          job.attempts > 1 ? `Retomada após expiração (tentativa ${job.attempts})` : `Problema ${job.problem}`,
        );
      }
      return job && { ...job, leaseMs };
    },
    renew(id, lease, update) {
      const now = Date.now();
      if (update !== undefined && !validProgress(update, get.get(id)?.problem)) return false;
      const serialized = update?.testResults !== undefined ? JSON.stringify(update.testResults) : null;
      const job = update === undefined ? renew.get(now + leaseMs, now, id, lease, now)
        : progress.get(now + leaseMs, now, update.phase, update.testsCompleted, serialized, id, lease, now, update.testsCompleted, update.phase);
      if (job) {
        heartbeat.run(job.worker, now);
        return true;
      }
      const saved = prior.get(id);
      if (saved && saved.status === 'running' && saved.lease === lease) {
        logEvent(now, 'stale_rejected', id, saved.worker, lease, saved.attempts, 'renew rejeitado (409)');
      } else if (saved && saved.lease !== lease) {
        logEvent(now, 'stale_rejected', id, null, lease, saved.attempts, 'renew rejeitado (409)');
      }
      return false;
    },
    finish(id, { lease, status, detail }) {
      const now = Date.now();
      const finished = finish.get(status, detail, now, id, lease, now);
      if (finished) {
        logEvent(now, 'finished', id, finished.worker, lease, finished.attempts, status);
        return true;
      }
      const saved = prior.get(id);
      if (saved?.lease === lease && saved.status === status) {
        logEvent(now, 'idempotent_replay', id, saved.worker, lease, saved.attempts, `${status} (idempotente)`);
        return true;
      }
      logEvent(now, 'stale_rejected', id, saved?.lease === lease ? saved.worker : null, lease, saved?.attempts ?? null, 'finish rejeitado (409)');
      return false;
    },
  };
}
