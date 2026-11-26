import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHandler } from './app.mjs';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.DB_PATH ?? 'data/judge.sqlite';
const leaseMs = Number(process.env.LEASE_MS ?? 10000);
const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 3);
const token = process.env.JUDGE_TOKEN ?? 'minijuiz-local';
if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !token) {
  throw new Error('Configuração de worker inválida.');
}

let store;
if (process.env.TURSO_DATABASE_URL) {
  const { createTursoStore } = await import('./turso-store.mjs');
  store = createTursoStore({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    leaseMs,
    maxAttempts,
  });
} else {
  const { createStore } = await import('./store.mjs');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  store = createStore(dbPath, leaseMs, maxAttempts);
}

const server = createServer(createHandler({ store, token }));
const socketPath = process.env.SOCKET_PATH;
if (socketPath) server.listen(socketPath, () => console.log(socketPath));
else server.listen(port, host, () => console.log(`http://${host}:${server.address().port}`));
