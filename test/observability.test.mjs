import assert from 'node:assert/strict';
import { test } from 'node:test';
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
