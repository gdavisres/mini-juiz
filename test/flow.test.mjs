import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';

test('a tarefa expirada é retomada e somente o dono atual pode concluir', async (t) => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\minijuiz-${process.pid}` : join(tmpdir(), `minijuiz-${process.pid}.sock`);
  const server = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, SOCKET_PATH: socketPath, DB_PATH: ':memory:', JUDGE_TOKEN: 'teste', LEASE_MS: '1200', MAX_ATTEMPTS: '4' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    if (process.platform !== 'win32') rmSync(socketPath, { force: true });
  });
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => {
    throw new Error('A API encerrou antes de aceitar conexões.');
  })]);
  const request = (path, body, token = 'teste') => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    }, async (res) => {
      try {
        const text = await Array.fromAsync(res);
        resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.concat(text).toString()) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  assert.equal((await request('/')).status, 200);
  const catalog = await request('/api/problems');
  assert.equal(catalog.status, 200);
  const problems = catalog.json();
  assert.deepEqual(problems.map(({ id }) => id), ['A', 'B', 'C']);
  for (const problem of problems) {
    for (const field of ['title', 'statement', 'input', 'output', 'example', 'difficulty', 'topic']) assert.ok(problem[field]);
    assert.equal('cases' in problem, false);
    assert.equal('expected' in problem, false);
  }
  assert.equal((await request('/api/problem')).json().id, 'A');
  for (const problem of ['B', 'C']) {
    assert.equal((await request('/api/submissions', { participant: 'Equipe', problem, source: 'int main(){}' })).status, 201);
    const job = (await request('/internal/claim', { worker: 'catalog-worker' })).json();
    assert.equal(job.problem, problem);
    assert.equal((await request(`/internal/jobs/${job.id}/finish`, { lease: job.lease, status: 'accepted' })).status, 200);
  }
  assert.equal((await request('/api/submissions', { participant: 'Equipe', problem: 'Z', source: 'int main(){}' })).status, 400);
  assert.equal((await request('/internal/claim', { worker: 'worker-1' }, 'invalido')).status, 401);
  const submitted = await request('/api/submissions', {
    participant: 'Equipe A', problem: 'A', source: 'int main() {}',
  });
  assert.equal(submitted.status, 201);
  const submission = await submitted.json();
  assert.equal(submission.status, 'queued');

  const [first, second] = await Promise.all(['worker-1', 'worker-2'].map(async (worker) => ({
    worker, response: await request('/internal/claim', { worker }),
  })));
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 204]);
  const owner = first.response.status === 200 ? first : second;
  const standby = owner === first ? second : first;
  const old = await owner.response.json();
  assert.equal(old.id, submission.id);
  assert.equal(old.attempts, 1);
  const progress = { lease: old.lease, phase: 'testing', testsCompleted: 1, testsTotal: 3 };
  assert.equal((await request(`/internal/jobs/${old.id}/renew`, progress, 'invalido')).status, 401);
  assert.equal((await request(`/internal/jobs/${old.id}/renew`, progress)).status, 204);
  assert.equal((await request(`/internal/jobs/${old.id}/renew`, { ...progress, testsTotal: 100 })).status, 400);
  const active = (await request('/api/dashboard')).json().activeSubmissions.find(({ id }) => id === old.id);
  assert.equal(active.phase, 'testing');
  assert.equal(active.testsCompleted, 1);
  assert.equal('lease' in active, false);
  assert.equal('source' in active, false);

  await new Promise((resolve) => setTimeout(resolve, 1300));
  const retry = await (await request('/internal/claim', { worker: standby.worker })).json();
  assert.equal((await request(`/internal/jobs/${old.id}/renew`, progress)).status, 409);
  assert.equal(retry.id, old.id);
  assert.equal(retry.attempts, 2);
  const finish = (job, status) => request(`/internal/jobs/${job.id}/finish`, { lease: job.lease, status });
  assert.equal((await finish(old, 'wrong_answer')).status, 409);
  assert.equal((await finish(retry, 'accepted')).status, 200);
  assert.equal((await finish(retry, 'accepted')).status, 200);
  const publicResult = await (await request(`/api/submissions/${old.id}`)).json();
  assert.equal(publicResult.status, 'accepted');
  assert.equal(publicResult.worker, standby.worker);
  assert.equal('lease' in publicResult, false);
  assert.equal('source' in publicResult, false);

  const dash = (await request('/api/dashboard')).json();
  assert.ok(dash.serverTime > 0);
  assert.equal(dash.config.maxAttempts, 4);
  assert.ok(dash.metrics.reclaims >= 1);
  assert.ok(dash.metrics.staleRejections >= 2);
  assert.ok(dash.metrics.idempotentReplays >= 1);
  const types = new Set(dash.events.map((e) => e.type));
  assert.ok(types.has('reclaimed') && types.has('stale_rejected') && types.has('idempotent_replay'));
  for (const event of dash.events) {
    if (event.leasePrefix) assert.ok(event.leasePrefix.length <= 8);
  }
});
