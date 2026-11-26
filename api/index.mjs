import { createHandler } from '../src/app.mjs';
import { createTursoStore } from '../src/turso-store.mjs';

let cachedHandler = null;

function getHandler() {
  if (cachedHandler) return cachedHandler;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const token = process.env.JUDGE_TOKEN;
  const leaseMs = Number(process.env.LEASE_MS ?? 10000);
  if (!url) throw new Error('Variável TURSO_DATABASE_URL não configurada.');
  if (!token) throw new Error('Variável JUDGE_TOKEN não configurada.');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error('Variável LEASE_MS inválida.');
  const store = createTursoStore({ url, authToken, leaseMs });
  cachedHandler = createHandler({ store, token });
  return cachedHandler;
}

export default async function handler(request, response) {
  let fn;
  try {
    fn = getHandler();
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ error: error.message }));
  }
  return fn(request, response);
}
