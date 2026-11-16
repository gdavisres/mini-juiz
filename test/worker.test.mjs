import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('o worker real corrige exemplos A/B/C e publica compilação e testes na API', { skip: !process.env.TEST_DOCKER, timeout: 90000 }, async (t) => {
  const children = [];
  const start = (file, environment) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    return child;
  };
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });
  const server = start('src/server.mjs', { PORT: '0', DB_PATH: ':memory:', JUDGE_TOKEN: 'docker-test', SOCKET_PATH: '' });
  const [output] = await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(() => { throw new Error('API encerrou antes de iniciar.'); }),
  ]);
  const api = output.toString().trim();
  const ids = [];
  for (const [problem, file] of [['A', 'soma'], ['B', 'maior'], ['C', 'parenteses']]) {
    const response = await fetch(`${api}/api/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant: 'Docker', problem, source: await readFile(`examples/${file}.cpp`, 'utf8') }),
    });
    assert.equal(response.status, 201);
    ids.push((await response.json()).id);
  }
  const worker = start('src/worker.mjs', { API_URL: api, JUDGE_TOKEN: 'docker-test', WORKER_ID: 'docker-integration' });
  worker.stdout.resume();
  const observed = new Map(ids.map((id) => [id, new Set()]));
  let dashboard;
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    dashboard = await (await fetch(`${api}/api/dashboard`)).json();
    for (const job of dashboard.submissions) {
      observed.get(job.id)?.add(job.phase);
      assert.ok(job.testsCompleted >= 0 && job.testsCompleted <= job.testsTotal);
    }
    if (dashboard.submissions.every(({ status }) => status === 'accepted')) break;
    await delay(50);
  }
  assert.equal(dashboard.counts.accepted, 3, JSON.stringify(dashboard.submissions));
  assert.equal(dashboard.activeSubmissions.length, 0);
  for (const job of dashboard.submissions) {
    assert.equal(job.worker, 'docker-integration');
    assert.equal(job.testsCompleted, job.testsTotal);
    assert.ok(observed.get(job.id).has('compiling'), `${job.problem}: faltou compilação`);
    assert.ok(observed.get(job.id).has('testing'), `${job.problem}: faltaram testes`);
  }
});
