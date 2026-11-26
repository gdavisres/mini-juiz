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
