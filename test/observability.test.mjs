import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';

test('sqlite store registra eventos distribuídos, métricas, leasePrefix e dead_letter', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createStore(':memory:', 1000, 2);

  const sub = store.submit({ participant: 'Equipe SD', problem: 'A', source: 'int main(){}' });
  assert.equal(sub.expires, null);
  assert.equal(sub.leasePrefix, null);

  now = 1200;
  const first = store.claim('w1');
  const running = store.get(sub.id);
  assert.equal(running.expires, 2200);
  assert.equal(running.leasePrefix, first.lease.slice(0, 8));
  assert.notEqual(running.leasePrefix, first.lease);

  // Lease expira -> renovação atrasada gera stale_rejected e w2 retoma
  now = 2300;
  assert.equal(store.renew(sub.id, first.lease), false);
  const second = store.claim('w2');
  assert.equal(second.attempts, 2);

  // Worker atrasado tenta finalizar -> rejeitado (stale_rejected)
  assert.equal(store.finish(sub.id, { lease: first.lease, status: 'accepted', detail: 'ok' }), false);

  // Dono atual finaliza + repetição idempotente
  now = 2800;
  assert.equal(store.finish(sub.id, { lease: second.lease, status: 'accepted', detail: 'ok' }), true);
  assert.equal(store.finish(sub.id, { lease: second.lease, status: 'accepted', detail: 'ok' }), true);

  const dash = store.dashboard();
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
  for (const event of dash.events) {
    if (event.leasePrefix) assert.equal(event.leasePrefix.length, 8);
  }

  // Dead-letter após maxAttempts = 2 sem novo claim (via sweep no dashboard)
  const sub2 = store.submit({ participant: 'Falha', problem: 'A', source: 'int main(){}' });
  const a1 = store.claim('w1');
  assert.equal(a1.id, sub2.id);
  now += 1100;
  const a2 = store.claim('w2');
  assert.equal(a2.id, sub2.id);
  assert.equal(a2.attempts, 2);
  now += 1100;
  const dashDead = store.dashboard();
  assert.equal(dashDead.counts.deadLetter, 1);
  assert.equal(dashDead.metrics.deadLetters, 1);
  assert.equal(store.get(sub2.id).status, 'dead_letter');
  assert.equal(store.claim('w1'), undefined);
  // Segundo dashboard() não duplica evento dead_letter
  const deadEvents = store.dashboard().events.filter((e) => e.type === 'dead_letter');
  assert.equal(deadEvents.length, 1);
});

test('sqlite store migra banco legado sem first_claimed_at, claimed_at e tabela events preservando dados', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minijuiz-obs-mig-'));
  const dbPath = join(dir, 'judge.sqlite');
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, lease TEXT,
      expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
      phase TEXT, tests_completed INTEGER NOT NULL DEFAULT 0, tests_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE workers (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
  `);
  legacy.prepare(`INSERT INTO submissions (id, participant, problem, source, status, created_at, tests_total)
    VALUES ('legacy-1', 'Equipe Antiga', 'A', 'int main(){}', 'queued', 1000, 3)`).run();
  legacy.close();

  const store = createStore(dbPath, 1000, 3);
  const dash = store.dashboard();
  assert.equal(dash.counts.total, 1);
  assert.equal(dash.counts.queued, 1);
  assert.equal(dash.metrics.avgQueueMs, null);
  assert.equal(dash.events.length, 0);

  const claimed = store.claim('worker-migrado');
  assert.equal(claimed.id, 'legacy-1');
  assert.equal(store.dashboard().events[0].type, 'claimed');
});

test('sqlite store persiste testResults e lastRenewedAt, preserva no heartbeat e limpa na retomada', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createStore(':memory:', 1000, 3);

  const sub = store.submit({ participant: 'Equipe Casos', problem: 'A', source: 'int main(){}' });
  assert.deepEqual(sub.testResults, []);
  assert.equal(sub.lastRenewedAt, null);

  now = 1100;
  const first = store.claim('worker-1');
  assert.deepEqual(store.get(sub.id).testResults, []);
  assert.equal(store.get(sub.id).lastRenewedAt, null);

  now = 1300;
  const cases1 = [
    { case: 1, status: 'passed', durationMs: 42 },
    { case: 2, status: 'running', durationMs: null },
  ];
  assert.equal(store.renew(first.id, first.lease, {
    phase: 'testing', testsCompleted: 1, testsTotal: 3, testResults: cases1,
  }), true);
  assert.deepEqual(store.get(sub.id).testResults, cases1);
  assert.equal(store.get(sub.id).lastRenewedAt, 1300);

  // Heartbeat puro atualiza lastRenewedAt sem apagar testResults
  now = 1600;
  assert.equal(store.renew(first.id, first.lease), true);
  assert.deepEqual(store.get(sub.id).testResults, cases1);
  assert.equal(store.get(sub.id).lastRenewedAt, 1600);

  // Expiração zera visualização pública; retomada limpa no banco
  now = 2700;
  assert.deepEqual(store.get(sub.id).testResults, []);
  assert.equal(store.get(sub.id).lastRenewedAt, null);

  const second = store.claim('worker-2');
  assert.deepEqual(store.get(sub.id).testResults, []);
  assert.equal(store.get(sub.id).lastRenewedAt, null);

  now = 2900;
  const finalCases = [
    { case: 1, status: 'passed', durationMs: 10 },
    { case: 2, status: 'passed', durationMs: 12 },
    { case: 3, status: 'passed', durationMs: 15 },
  ];
  assert.equal(store.renew(second.id, second.lease, {
    phase: 'testing', testsCompleted: 3, testsTotal: 3, testResults: finalCases,
  }), true);
  assert.equal(store.finish(second.id, { lease: second.lease, status: 'accepted', detail: '3 casos aprovados' }), true);
  assert.deepEqual(store.get(sub.id).testResults, finalCases);
  assert.deepEqual(store.dashboard().recentResults[0].testResults, finalCases);
});

test('sqlite store tolera test_results corrompido no banco sem quebrar o dashboard', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minijuiz-badjson-'));
  const dbPath = join(dir, 'judge.sqlite');
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const store = createStore(dbPath, 1000, 3);
  const sub = store.submit({ participant: 'Corrompido', problem: 'A', source: 'int main(){}' });
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE submissions SET test_results = '{invalido' WHERE id = ?").run(sub.id);
  raw.close();

  assert.deepEqual(store.get(sub.id).testResults, []);
  assert.deepEqual(store.dashboard().submissions[0].testResults, []);
});
