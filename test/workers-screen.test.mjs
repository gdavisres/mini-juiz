import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createHandler } from '../src/app.mjs';
import { createStore } from '../src/store.mjs';

async function startTestServer(t) {
  const store = createStore(':memory:', 5000, 3);
  const server = createServer(createHandler({ store, token: 'test-token' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, store };
}

test('API valida testResults no /internal/jobs/:id/renew e expõe no /api/dashboard', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

  const created = await (await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participant: 'Equipe HTTP', problem: 'A', source: 'int main(){}' }),
  })).json();

  const claimed = await (await fetch(`${baseUrl}/internal/claim`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ worker: 'worker-1' }),
  })).json();

  // testResults inválido -> 400
  const badRes = await fetch(`${baseUrl}/internal/jobs/${claimed.id}/renew`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      lease: claimed.lease,
      phase: 'testing',
      testsCompleted: 1,
      testsTotal: 3,
      testResults: [{ case: 99, status: 'passed', durationMs: 10 }],
    }),
  });
  assert.equal(badRes.status, 400);

  // testResults enviado sem phase -> 400
  const orphanRes = await fetch(`${baseUrl}/internal/jobs/${claimed.id}/renew`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      lease: claimed.lease,
      testResults: [{ case: 1, status: 'running', durationMs: null }],
    }),
  });
  assert.equal(orphanRes.status, 400);

  // testResults válido -> 204 e visível no dashboard
  const testResults = [
    { case: 1, status: 'passed', durationMs: 18 },
    { case: 2, status: 'running', durationMs: null },
  ];
  const okRes = await fetch(`${baseUrl}/internal/jobs/${claimed.id}/renew`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      lease: claimed.lease,
      phase: 'testing',
      testsCompleted: 1,
      testsTotal: 3,
      testResults,
    }),
  });
  assert.equal(okRes.status, 204);

  const dash = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  const active = dash.activeSubmissions.find((item) => item.id === created.id);
  assert.deepEqual(active.testResults, testResults);
  assert.equal(typeof active.lastRenewedAt, 'number');
});

test('servidor entrega /workers, /workers.html, /workers.css e /workers.js com CSP', async (t) => {
  const { baseUrl } = await startTestServer(t);
  for (const [path, expectedType] of [
    ['/workers', 'text/html'],
    ['/workers.html', 'text/html'],
    ['/workers.css', 'text/css'],
    ['/workers.js', 'text/javascript'],
  ]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 200, `${path} deveria retornar 200`);
    assert.ok(res.headers.get('content-type').startsWith(expectedType), `${path} content-type`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'self'"), `${path} CSP`);
    assert.equal(csp.includes("script-src 'unsafe-inline'"), false);
  }
});
