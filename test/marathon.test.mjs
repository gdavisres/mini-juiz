import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { judge } from '../src/judge.mjs';

test('cada problema corrige seus casos e informa progresso após cada execução', async () => {
  for (const id of ['A', 'B', 'C']) {
    const progress = [];
    let limits;
    const runner = {
      compile: async (_source, problem) => { limits = problem; return { code: 0, stdout: Buffer.from('binary') }; },
      run: async (_binary, input, problem) => {
        assert.equal(problem, limits);
        let output;
        if (id === 'A') output = input.trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0);
        if (id === 'B') output = Math.max(...input.trim().split(/\s+/).slice(1).map(Number));
        if (id === 'C') {
          let depth = 0;
          let valid = true;
          for (const character of input.trim()) { depth += character === '(' ? 1 : -1; if (depth < 0) valid = false; }
          output = valid && depth === 0 ? 'SIM' : 'NAO';
        }
        return { code: 0, stdout: Buffer.from(String(output)) };
      },
    };
    assert.equal((await judge('source', runner, id, async (value) => progress.push(value))).status, 'accepted');
    assert.equal(limits.id, id);
    assert.ok(limits.timeLimit > 0 && limits.memoryLimit > 0);
    const total = progress[0].testsTotal;
    assert.ok(total >= 3);
    assert.deepEqual(progress, [
      { phase: 'compiling', testsCompleted: 0, testsTotal: total },
      ...Array.from({ length: total + 1 }, (_, count) => ({ phase: 'testing', testsCompleted: count, testsTotal: total })),
    ]);
    const incorrect = { ...runner, run: async () => ({ code: 0, stdout: Buffer.from('incorreto') }) };
    assert.equal((await judge('source', incorrect, id)).status, 'wrong_answer');
  }
});

test('o progresso respeita casos, ordem e dono da reserva, e reinicia na retomada', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createStore(':memory:', 1000);
  const submitted = store.submit({ participant: 'Equipe', problem: 'A', source: 'source' });
  assert.equal(submitted.phase, null);
  assert.equal(submitted.testsCompleted, 0);
  assert.equal(submitted.testsTotal, 3);
  const first = store.claim('w1');
  const progress = { phase: 'testing', testsCompleted: 1, testsTotal: 3 };
  assert.equal(store.renew(first.id, first.lease, progress), true);
  assert.equal(store.renew(first.id, first.lease), true);
  assert.equal(store.get(first.id).phase, 'testing');
  assert.equal(store.get(first.id).testsCompleted, 1);
  assert.equal(store.renew(first.id, first.lease, { ...progress, testsTotal: 999 }), false);
  assert.equal(store.renew(first.id, first.lease, { ...progress, testsCompleted: 4 }), false);
  assert.equal(store.renew(first.id, first.lease, { ...progress, testsCompleted: 0 }), false);
  assert.equal(store.renew(first.id, first.lease, { phase: 'compiling', testsCompleted: 0, testsTotal: 3 }), false);
  now += 1001;
  assert.equal(store.renew(first.id, first.lease, progress), false);
  assert.equal(store.get(first.id).status, 'queued');
  assert.equal(store.get(first.id).phase, null);
  assert.equal(store.get(first.id).testsCompleted, 0);
  const second = store.claim('w2');
  assert.equal(store.get(second.id).phase, null);
  assert.equal(store.get(second.id).testsCompleted, 0);
  assert.equal(store.renew(first.id, first.lease, progress), false);
  assert.equal(store.renew(second.id, second.lease, progress), true);
});

test('os workers mantêm a posição no painel quando consultam a fila ou renovam uma correção', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createStore(':memory:', 10000);
  const submitted = store.submit({ participant: 'Equipe', problem: 'A', source: 'source' });
  const job = store.claim('worker-1');
  store.claim('worker-2');
  const order = () => store.dashboard().workers.map(({ id }) => id);
  assert.deepEqual(order(), ['worker-1', 'worker-2']);

  now += 650;
  assert.equal(store.claim('worker-2'), undefined);
  assert.deepEqual(order(), ['worker-1', 'worker-2']);

  now += 650;
  assert.equal(store.renew(job.id, job.lease), true);
  assert.deepEqual(order(), ['worker-1', 'worker-2']);
  assert.equal(store.get(submitted.id).worker, 'worker-1');
  assert.equal(store.get(submitted.id).attempts, 1);
  assert.equal(store.dashboard().workers.find(({ id }) => id === 'worker-1').status, 'busy');
});

test('o painel inclui tarefas ativas mesmo fora das 50 submissões recentes', () => {
  const store = createStore(':memory:', 1000);
  const oldest = store.submit({ participant: 'Antiga', problem: 'A', source: 'source' });
  store.claim('w1');
  for (let i = 0; i < 60; i += 1) store.submit({ participant: 'Nova', problem: 'B', source: 'source' });
  const dashboard = store.dashboard();
  assert.equal(dashboard.submissions.length, 50);
  assert.equal(dashboard.submissions.some((job) => job.id === oldest.id), false);
  assert.equal(dashboard.activeSubmissions.some((job) => job.id === oldest.id && job.worker === 'w1'), true);
  assert.equal(dashboard.activeSubmissions.length, 61);
  for (let i = 0; i < 50; i += 1) store.submit({ participant: 'Mais', problem: 'C', source: 'source' });
  assert.equal(store.dashboard().activeSubmissions.length, 100);
});

test('resultados recentes incluem tarefas antigas e seguem a ordem de conclusão', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createStore(':memory:', 10000);
  const oldest = store.submit({ participant: 'Antiga', problem: 'A', source: 'source' });
  const oldestJob = store.claim('w1');
  now += 1;
  const newer = store.submit({ participant: 'Nova', problem: 'B', source: 'source' });
  const newerJob = store.claim('w2');
  for (let i = 0; i < 60; i += 1) store.submit({ participant: 'Fila', problem: 'C', source: 'source' });
  now += 1;
  store.finish(newer.id, { lease: newerJob.lease, status: 'accepted', detail: null });
  now += 1;
  store.finish(oldest.id, { lease: oldestJob.lease, status: 'wrong_answer', detail: null });
  const dashboard = store.dashboard();
  assert.equal(dashboard.submissions.some(({ id }) => id === oldest.id), false);
  assert.deepEqual(dashboard.recentResults.map(({ id }) => id), [oldest.id, newer.id]);
  assert.equal('source' in dashboard.recentResults[0], false);
  assert.equal('lease' in dashboard.recentResults[0], false);
  assert.equal(dashboard.recentResults[0].status, 'wrong_answer');
});

test('SQLite antigo recebe colunas de progresso preservando dados e permite reabrir', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'minijuiz-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'judge.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY, participant TEXT NOT NULL, problem TEXT NOT NULL,
    source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
    worker TEXT, lease TEXT, expires INTEGER, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
  ); INSERT INTO submissions (id, participant, problem, source, created_at) VALUES ('old', 'Equipe antiga', 'A', 'source', 1);`);
  db.close();
  const store = createStore(path, 1000);
  assert.equal(store.get('old').participant, 'Equipe antiga');
  assert.equal(store.get('old').testsCompleted, 0);
  assert.equal(store.get('old').testsTotal, 3);
  assert.equal(createStore(path, 1000).get('old').phase, null);
});
