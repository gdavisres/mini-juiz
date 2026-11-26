import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { problem, problems, getProblem, validProgress } from './problems.mjs';

const verdicts = ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'judge_error'];

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.css', ['app.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/editor.js', ['editor.js', 'text/javascript']],
  ['/editor-LICENSE.txt', ['editor-LICENSE.txt', 'text/plain']],
  ['/workers', ['workers.html', 'text/html']],
  ['/workers.html', ['workers.html', 'text/html']],
  ['/workers.css', ['workers.css', 'text/css']],
  ['/workers.js', ['workers.js', 'text/javascript']],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(data === undefined ? undefined : JSON.stringify(data));
}

async function body(request) {
  let preParsed;
  try {
    preParsed = request.body;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
  if (preParsed !== undefined) {
    let parsed = preParsed;
    if (typeof parsed === 'string' || Buffer.isBuffer(parsed)) {
      const raw = typeof parsed === 'string' ? parsed : parsed.toString('utf8');
      if (Buffer.byteLength(raw) > 256 * 1024) throw new HttpError(413, 'A requisição é grande demais.');
      try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON inválido.'); }
    } else if (Buffer.byteLength(JSON.stringify(parsed)) > 256 * 1024) {
      throw new HttpError(413, 'A requisição é grande demais.');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new HttpError(400, 'JSON inválido.');
    return parsed;
  }

  const parts = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 256 * 1024) {
      request.resume();
      throw new HttpError(413, 'A requisição é grande demais.');
    }
    parts.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new HttpError(400, 'JSON inválido.'); }
}

function submission(data) {
  const participant = typeof data.participant === 'string' ? data.participant.trim() : '';
  if (!participant || participant.length > 40) throw new HttpError(400, 'Informe um nome de até 40 caracteres.');
  if (!getProblem(data.problem)) throw new HttpError(400, 'Problema inválido.');
  if (typeof data.source !== 'string' || !data.source.trim() || Buffer.byteLength(data.source) > 32768) {
    throw new HttpError(400, 'Envie código C++ com até 32 KiB.');
  }
  return { participant, problem: data.problem, source: data.source };
}

export function createHandler({ store, token }) {
  const auth = Buffer.from(`Bearer ${token}`);

  async function workerRequest(request, response, path) {
    const provided = Buffer.from(request.headers.authorization ?? '');
    if (provided.length !== auth.length || !timingSafeEqual(provided, auth)) throw new HttpError(401, 'Worker não autorizado.');
    if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
    const data = await body(request);
    if (path === '/internal/claim') {
      if (typeof data.worker !== 'string' || !/^[\w.-]{1,80}$/.test(data.worker)) throw new HttpError(400, 'Nome do worker inválido.');
      const job = await store.claim(data.worker);
      return send(response, job ? 200 : 204, job);
    }
    const job = /^\/internal\/jobs\/([\da-f-]+)\/(renew|finish)$/.exec(path);
    if (!job) throw new HttpError(404, 'Rota inexistente.');
    if (typeof data.lease !== 'string') throw new HttpError(400, 'Reserva inválida.');
    const [, id, operation] = job;
    if (operation === 'renew') {
      const hasProgress = ['phase', 'testsCompleted', 'testsTotal', 'testResults'].some((field) => Object.hasOwn(data, field));
      const current = await store.get(id);
      if (hasProgress && current && !validProgress(data, current.problem)) throw new HttpError(400, 'Progresso inválido.');
      if (!(await store.renew(id, data.lease, hasProgress ? data : undefined))) {
        throw new HttpError(409, 'A reserva expirou ou o progresso regrediu.');
      }
      return send(response, 204);
    }
    if (!verdicts.includes(data.status)) throw new HttpError(400, 'Veredito inválido.');
    const detail = typeof data.detail === 'string' ? data.detail.slice(0, 1600) : null;
    if (!(await store.finish(id, { ...data, detail }))) throw new HttpError(409, 'A reserva expirou.');
    return send(response, 200, await store.get(id));
  }

  async function handle(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;
    const method = request.method;
    if (path.startsWith('/internal/')) return workerRequest(request, response, path);
    if (method === 'GET' && assets.has(path)) {
      const [name, type] = assets.get(path);
      const nonce = randomBytes(18).toString('base64');
      const asset = await readFile(new URL(`../public/${name}`, import.meta.url));
      const file = path === '/' ? asset.toString('utf8').replace('__EDITOR_STYLE_NONCE__', nonce) : asset;
      response.writeHead(200, {
        'Content-Type': `${type}; charset=utf-8`,
        'Content-Security-Policy': `default-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(file);
    }
    if (method === 'GET' && path === '/api/problem') return send(response, 200, problem);
    if (method === 'GET' && path === '/api/problems') return send(response, 200, problems);
    if (method === 'GET' && path === '/api/dashboard') return send(response, 200, await store.dashboard());
    if (method === 'POST' && path === '/api/submissions') {
      return send(response, 201, await store.submit(submission(await body(request))));
    }
    const match = /^\/api\/submissions\/([\da-f-]+)$/.exec(path);
    if (method === 'GET' && match) {
      const result = await store.get(match[1]);
      if (result) return send(response, 200, result);
    }
    throw new HttpError(404, 'Rota inexistente.');
  }

  return (request, response) => handle(request, response).catch((error) => {
    if (!(error instanceof HttpError)) console.error(error);
    if (!response.headersSent) send(response, error.status ?? 500, { error: error.status ? error.message : 'Erro interno.' });
  });
}
