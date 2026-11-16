import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { judge, runnerImage } from './judge.mjs';

const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
const token = process.env.JUDGE_TOKEN ?? 'minijuiz-local';
const worker = process.env.WORKER_ID ?? `${hostname().replace(/[^\w.-]/g, '-')}-${process.pid}`;

async function post(path, data) {
  return fetch(new URL(`/internal/${path}`, api), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(4000),
  });
}

async function processJob(job) {
  const path = `jobs/${job.id}`;
  const { lease } = job;
  const controller = new AbortController();
  let expired = false;
  const renew = async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(Math.min(2500, job.leaseMs / 3), undefined, { signal: controller.signal });
        if ((await post(`${path}/renew`, { lease })).status === 409) { expired = true; return; }
      } catch (error) {
        if (!controller.signal.aborted) console.error('Renovação:', error.message);
      }
    }
  };
  const renewal = renew();
  try {
    console.log(`${job.id} · tentativa ${job.attempts}`);
    const result = await judge(job.source, undefined, job.problem, async (progress) => {
      if (expired) throw new Error('A reserva expirou.');
      try {
        const response = await post(`${path}/renew`, { lease, ...progress });
        if (response.status === 409) { expired = true; throw new Error('A reserva expirou.'); }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (expired) throw error;
        console.error('Envio do progresso:', error.message);
      }
    });
    for (let attempt = 0; attempt < 3 && !expired; attempt += 1) {
      try {
        const response = await post(`${path}/finish`, { ...result, lease });
        if (response.status === 409) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        console.log(`${job.id} · ${result.status}`);
        return;
      } catch (error) {
        console.error('Envio do resultado:', error.message);
        await delay(500);
      }
    }
  } finally {
    controller.abort();
    await renewal;
  }
}

try {
  execFileSync('docker', ['image', 'inspect', runnerImage], { stdio: 'ignore', timeout: 8000, windowsHide: true });
} catch {
  console.error(`Ative o Docker e construa a imagem ${runnerImage} antes de iniciar o worker.`);
  process.exit(1);
}

console.log(`Worker ${worker} conectado à configuração ${api}`);
while (true) {
  try {
    const response = await post('claim', { worker });
    if (response.status === 204) { await delay(650); continue; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await processJob(await response.json());
  } catch (error) {
    console.error('Consulta à fila:', error.message);
    await delay(1800);
  }
}
