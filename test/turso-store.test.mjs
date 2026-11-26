import assert from 'node:assert/strict';
import { test } from 'node:test';
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
