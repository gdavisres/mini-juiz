import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { createTursoStore } from '../src/turso-store.mjs';

test('turso store suporta submissão, reserva, progresso, expiração, retomada e conclusão idempotente', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createTursoStore({ url: ':memory:', leaseMs: 1000 });

  const submitted = await store.submit({ participant: 'Equipe Turso', problem: 'A', source: 'int main(){}' });
  assert.equal(submitted.status, 'queued');
  assert.equal(submitted.phase, null);
  assert.equal(submitted.testsCompleted, 0);
  assert.equal(submitted.testsTotal, 3);

  const first = await store.claim('worker-1');
  assert.equal(first.id, submitted.id);
  assert.equal(first.attempts, 1);
  assert.equal(first.leaseMs, 1000);
  assert.equal(await store.claim('worker-2'), undefined);

  const progress = { phase: 'testing', testsCompleted: 1, testsTotal: 3 };
  assert.equal(await store.renew(first.id, first.lease, progress), true);
  assert.equal(await store.renew(first.id, first.lease), true);
  assert.equal((await store.get(first.id)).phase, 'testing');
  assert.equal((await store.get(first.id)).testsCompleted, 1);
  assert.equal(await store.renew(first.id, first.lease, { ...progress, testsCompleted: 0 }), false);

  const dashRunning = await store.dashboard();
  assert.equal(dashRunning.counts.total, 1);
  assert.equal(dashRunning.counts.running, 1);
  assert.equal(dashRunning.counts.queued, 0);
  assert.equal(dashRunning.workers.length, 2);

  now += 1001;
  assert.equal(await store.renew(first.id, first.lease, progress), false);
  assert.equal((await store.get(first.id)).status, 'queued');
  assert.equal((await store.get(first.id)).phase, null);

  const second = await store.claim('worker-2');
  assert.equal(second.id, submitted.id);
  assert.equal(second.attempts, 2);
  assert.equal(await store.finish(first.id, { lease: first.lease, status: 'accepted', detail: null }), false);
  assert.equal(await store.finish(second.id, { lease: second.lease, status: 'accepted', detail: 'OK' }), true);
  assert.equal(await store.finish(second.id, { lease: second.lease, status: 'accepted', detail: 'OK' }), true);

  const final = await store.get(second.id);
  assert.equal(final.status, 'accepted');
  assert.equal(final.detail, 'OK');
  assert.equal((await store.dashboard()).counts.accepted, 1);
});

test('turso store registra eventos distribuídos, métricas, leasePrefix e dead_letter', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createTursoStore({ url: ':memory:', leaseMs: 1000, maxAttempts: 2 });

  const sub = await store.submit({ participant: 'Equipe SD', problem: 'A', source: 'int main(){}' });
  assert.equal(sub.expires, null);
  assert.equal(sub.leasePrefix, null);

  now = 1200;
  const first = await store.claim('w1');
  const running = await store.get(sub.id);
  assert.equal(running.expires, 2200);
  assert.equal(running.leasePrefix, first.lease.slice(0, 8));
  assert.notEqual(running.leasePrefix, first.lease);

  now = 2300;
  assert.equal(await store.renew(sub.id, first.lease), false);
  const second = await store.claim('w2');
  assert.equal(second.attempts, 2);
  assert.equal(await store.finish(sub.id, { lease: first.lease, status: 'accepted', detail: 'ok' }), false);

  now = 2800;
  assert.equal(await store.finish(sub.id, { lease: second.lease, status: 'accepted', detail: 'ok' }), true);
  assert.equal(await store.finish(sub.id, { lease: second.lease, status: 'accepted', detail: 'ok' }), true);

  const dash = await store.dashboard();
  assert.equal(dash.serverTime, 2800);
  assert.deepEqual(dash.config, { leaseMs: 1000, maxAttempts: 2 });
  assert.equal(dash.metrics.avgQueueMs, 200);
  assert.equal(dash.metrics.avgExecMs, 500);
  assert.equal(dash.metrics.reclaims, 1);
  assert.equal(dash.metrics.staleRejections, 2);
  assert.equal(dash.metrics.idempotentReplays, 1);
  assert.equal(dash.metrics.deadLetters, 0);
  assert.deepEqual(
    dash.events.map((e) => e.type).reverse(),
    ['submitted', 'claimed', 'stale_rejected', 'reclaimed', 'stale_rejected', 'finished', 'idempotent_replay'],
  );

  const sub2 = await store.submit({ participant: 'Falha', problem: 'A', source: 'int main(){}' });
  await store.claim('w1');
  now += 1100;
  await store.claim('w2');
  now += 1100;
  const dashDead = await store.dashboard();
  assert.equal(dashDead.counts.deadLetter, 1);
  assert.equal(dashDead.metrics.deadLetters, 1);
  assert.equal((await store.get(sub2.id)).status, 'dead_letter');
  assert.equal(await store.claim('w1'), undefined);
  assert.equal((await store.dashboard()).events.filter((e) => e.type === 'dead_letter').length, 1);
});

test('turso store migra banco legado sem first_claimed_at, claimed_at e tabela events preservando dados', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minijuiz-turso-mig-'));
  const fileUrl = pathToFileURL(join(dir, 'judge.sqlite')).href;
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const legacy = createClient({ url: fileUrl });
  await legacy.batch([
    `CREATE TABLE submissions (
      id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
      expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
      phase TEXT, tests_completed INTEGER NOT NULL DEFAULT 0, tests_total INTEGER NOT NULL DEFAULT 0
    )`,
    'CREATE TABLE workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)',
    `INSERT INTO submissions (id, participant, problem, source, status, created_at, tests_total)
      VALUES ('legacy-t1', 'Equipe Antiga', 'A', 'int main(){}', 'queued', 1000, 3)`,
  ], 'write');
  legacy.close();

  const store = createTursoStore({ url: fileUrl, leaseMs: 1000, maxAttempts: 3 });
  const dash = await store.dashboard();
  assert.equal(dash.counts.total, 1);
  assert.equal(dash.counts.queued, 1);
  assert.equal(dash.metrics.avgQueueMs, null);
  assert.equal(dash.events.length, 0);

  const claimed = await store.claim('worker-migrado');
  assert.equal(claimed.id, 'legacy-t1');
  assert.equal((await store.dashboard()).events[0].type, 'claimed');
});

test('turso store persiste testResults e lastRenewedAt, preserva no heartbeat e limpa na retomada', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createTursoStore({ url: ':memory:', leaseMs: 1000, maxAttempts: 3 });

  const sub = await store.submit({ participant: 'Equipe Turso Casos', problem: 'A', source: 'int main(){}' });
  assert.deepEqual(sub.testResults, []);
  assert.equal(sub.lastRenewedAt, null);

  now = 1100;
  const first = await store.claim('worker-1');
  assert.deepEqual((await store.get(sub.id)).testResults, []);
  assert.equal((await store.get(sub.id)).lastRenewedAt, null);

  now = 1300;
  const cases1 = [
    { case: 1, status: 'passed', durationMs: 35 },
    { case: 2, status: 'running', durationMs: null },
  ];
  assert.equal(await store.renew(first.id, first.lease, {
    phase: 'testing', testsCompleted: 1, testsTotal: 3, testResults: cases1,
  }), true);
  assert.deepEqual((await store.get(sub.id)).testResults, cases1);
  assert.equal((await store.get(sub.id)).lastRenewedAt, 1300);

  // Heartbeat puro atualiza lastRenewedAt sem apagar testResults
  now = 1600;
  assert.equal(await store.renew(first.id, first.lease), true);
  assert.deepEqual((await store.get(sub.id)).testResults, cases1);
  assert.equal((await store.get(sub.id)).lastRenewedAt, 1600);

  // Expiração zera visualização pública; retomada limpa no banco
  now = 2700;
  assert.deepEqual((await store.get(sub.id)).testResults, []);
  assert.equal((await store.get(sub.id)).lastRenewedAt, null);

  const second = await store.claim('worker-2');
  assert.deepEqual((await store.get(sub.id)).testResults, []);
  assert.equal((await store.get(sub.id)).lastRenewedAt, null);

  now = 2900;
  const finalCases = [
    { case: 1, status: 'passed', durationMs: 10 },
    { case: 2, status: 'passed', durationMs: 12 },
    { case: 3, status: 'passed', durationMs: 15 },
  ];
  assert.equal(await store.renew(second.id, second.lease, {
    phase: 'testing', testsCompleted: 3, testsTotal: 3, testResults: finalCases,
  }), true);
  assert.equal(await store.finish(second.id, { lease: second.lease, status: 'accepted', detail: '3 casos aprovados' }), true);
  assert.deepEqual((await store.get(sub.id)).testResults, finalCases);
  assert.deepEqual((await store.dashboard()).recentResults[0].testResults, finalCases);
});

test('turso store tolera test_results corrompido no banco sem quebrar o dashboard', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minijuiz-turso-badjson-'));
  const fileUrl = pathToFileURL(join(dir, 'judge.sqlite')).href;
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const store = createTursoStore({ url: fileUrl, leaseMs: 1000, maxAttempts: 3 });
  const sub = await store.submit({ participant: 'Corrompido', problem: 'A', source: 'int main(){}' });
  const raw = createClient({ url: fileUrl });
  await raw.execute({ sql: "UPDATE submissions SET test_results = '{invalido' WHERE id = ?", args: [sub.id] });
  raw.close();

  assert.deepEqual((await store.get(sub.id)).testResults, []);
  assert.deepEqual((await store.dashboard()).submissions[0].testResults, []);
});
