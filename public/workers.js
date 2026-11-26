const byId = (id) => document.getElementById(id);

const verdictLabels = {
  queued: 'Na fila', running: 'Em correção', accepted: 'Accepted', wrong_answer: 'Wrong Answer',
  compile_error: 'Compilation Error', runtime_error: 'Runtime Error', time_limit: 'Time Limit Exceeded',
  judge_error: 'Erro do juiz', dead_letter: 'Dead Letter',
};

const workerLabels = { online: 'Disponível', busy: 'Corrigindo', offline: 'Offline' };

const eventLabels = {
  submitted: 'Submetida', claimed: 'Reservada', reclaimed: 'Retomada',
  stale_rejected: 'Rejeitada (409)', idempotent_replay: 'Idempotente',
  finished: 'Concluída', dead_letter: 'Dead Letter',
};

const caseStatusLabels = {
  pending: 'Aguardando',
  running: 'Executando…',
  passed: 'Aprovado',
  wrong_answer: 'Wrong Answer',
  time_limit: 'Time Limit',
  runtime_error: 'Runtime Error',
  judge_error: 'Erro do juiz',
};

const caseSymbols = {
  pending: '·',
  running: '⏳',
  passed: '✓',
  wrong_answer: '✗',
  time_limit: '⏱',
  runtime_error: '!',
  judge_error: '!',
};

const timeFmt = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' });

let selectedWorkerId = new URLSearchParams(window.location.search).get('id') || null;
let clockOffset = 0;
let leaseMs = 10000;
let lastDashboard = null;
let previousSelector = '';
let previousQueue = '';
let previousWorkers = '';
let previousResults = '';
let previousEvents = '';
let previousFocus = '';
const lastRenewSeen = new Map();
const pulseUntil = new Map();

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

function formatAgo(timestamp, now) {
  if (!timestamp) return 'Sem renovação ainda';
  const diff = Math.max(0, now - timestamp);
  return `Renovado há ${(diff / 1000).toFixed(1).replace('.', ',')} s`;
}

function verdictCategory(status) {
  return status === 'accepted' ? 'accepted' : 'failure';
}

function caseClass(status) {
  if (status === 'passed') return 'passed';
  if (status === 'running') return 'running';
  if (status === 'pending') return 'pending';
  return 'failed';
}

function setSelectedWorker(id) {
  selectedWorkerId = id || null;
  const url = new URL(window.location.href);
  if (selectedWorkerId) url.searchParams.set('id', selectedWorkerId);
  else url.searchParams.delete('id');
  window.history.replaceState({}, '', url);
  if (lastDashboard) renderAll(lastDashboard);
}

function setConnection(connected) {
  const badge = byId('connection');
  const label = connected ? 'API conectada' : 'API indisponível';
  badge.classList.toggle('connected', connected);
  badge.replaceChildren(el('span', undefined, 'dot'), document.createTextNode(label));
}

function buildCaseList(job) {
  const total = job.testsTotal || 0;
  const byCase = new Map((job.testResults ?? []).map((entry) => [entry.case, entry]));
  return Array.from({ length: total }, (_, idx) => {
    const number = idx + 1;
    const found = byCase.get(number);
    if (found) return found;
    return { case: number, status: 'pending', durationMs: null };
  });
}

function stepState(job, stepIndex) {
  if (!job) return '';
  if (stepIndex === 0) return 'done'; // Claim
  if (stepIndex === 1) { // Compilação
    if (job.phase === 'testing') return 'done';
    if (job.phase === 'compiling') return 'active';
    return 'active';
  }
  if (stepIndex === 2) { // Testes
    if (job.phase === 'testing' && job.testsTotal > 0 && job.testsCompleted >= job.testsTotal) return 'done';
    if (job.phase === 'testing') return 'active';
    return '';
  }
  if (stepIndex === 3) { // Retorno
    if (job.phase === 'testing' && job.testsTotal > 0 && job.testsCompleted >= job.testsTotal) return 'active';
    return '';
  }
  return '';
}

function renderSelector(workers) {
  const key = JSON.stringify([selectedWorkerId, workers.map(({ id, status }) => [id, status])]);
  if (key === previousSelector) return;
  previousSelector = key;
  const container = byId('worker-selector');
  const allBtn = el('button', 'Todos os workers', 'selector-pill');
  allBtn.type = 'button';
  allBtn.setAttribute('aria-pressed', String(!selectedWorkerId));
  allBtn.addEventListener('click', () => setSelectedWorker(null));

  const ids = workers.map((w) => w.id);
  const items = [allBtn];
  for (const w of workers) {
    const btn = el('button', undefined, 'selector-pill');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(selectedWorkerId === w.id));
    btn.append(el('span', undefined, `dot dot-${w.status}`), document.createTextNode(w.id));
    btn.addEventListener('click', () => setSelectedWorker(w.id));
    items.push(btn);
  }
  if (selectedWorkerId && !ids.includes(selectedWorkerId)) {
    const missing = el('button', undefined, 'selector-pill');
    missing.type = 'button';
    missing.setAttribute('aria-pressed', 'true');
    missing.append(el('span', undefined, 'dot dot-offline'), document.createTextNode(selectedWorkerId));
    items.push(missing);
  }
  container.replaceChildren(...items);
}

function renderSummary(data) {
  byId('count-queued').textContent = String(data.counts.queued);
  byId('count-running').textContent = String(data.counts.running);
  byId('count-accepted').textContent = String(data.counts.accepted);
  byId('count-total').textContent = String(data.counts.total);
  if (data.metrics) {
    byId('metric-latency').textContent = `${formatDuration(data.metrics.avgQueueMs)} · ${formatDuration(data.metrics.avgExecMs)}`;
    byId('metric-faults').textContent = `${data.metrics.reclaims} · ${data.metrics.staleRejections} · ${data.metrics.deadLetters}`;
  }
  if (data.config) {
    byId('protocol-config').textContent = `Lease ${formatDuration(data.config.leaseMs)} · Máx. ${data.config.maxAttempts} tentativas`;
  }
}

function renderQueue(active, counts) {
  const queued = active.filter((item) => item.status === 'queued');
  const key = JSON.stringify([counts.queued, queued.slice(0, 12)]);
  if (key === previousQueue) return;
  previousQueue = key;
  byId('queue-badge').textContent = String(counts.queued);
  const list = byId('queue-list');
  if (!queued.length) {
    list.replaceChildren(el('li', 'Nenhuma tarefa aguardando na fila.', 'empty'));
    return;
  }
  list.replaceChildren(...queued.slice(0, 12).map((job, idx) => {
    const li = el('li', undefined, 'queue-card');
    const info = el('div', undefined, 'queue-info');
    info.append(
      el('strong', job.participant),
      el('small', `Problema ${job.problem} · #${job.id.slice(0, 6)}`),
    );
    if (job.attempts > 0) {
      info.append(el('span', `Retomada (${job.attempts} tentativa${job.attempts > 1 ? 's' : ''})`, 'reclaim-tag'));
    }
    li.append(
      el('span', String(idx + 1).padStart(2, '0'), 'queue-pos'),
      el('span', job.problem, `problem-badge problem-${job.problem}`),
      info,
    );
    return li;
  }));
}

function createTtlBox(job, now) {
  const box = el('div', undefined, 'ttl-box');
  box.dataset.expires = String(job.expires);
  box.dataset.leasePrefix = job.leasePrefix ?? '';
  const header = el('div', undefined, 'ttl-header');
  header.append(el('span', '', 'ttl-text'), el('span', job.leasePrefix ? `lease ${job.leasePrefix}` : '', 'ttl-lease'));
  const bar = el('progress', undefined, 'ttl-bar');
  bar.max = leaseMs;
  bar.value = Math.max(0, job.expires - now);
  box.append(header, bar);
  return box;
}

function createCasesChips(job) {
  const wrap = el('div', undefined, 'cases-grid');
  for (const item of buildCaseList(job)) {
    const label = item.durationMs !== null && item.durationMs !== undefined
      ? `C${item.case} ${caseSymbols[item.status] ?? '·'} ${formatDuration(item.durationMs)}`
      : `C${item.case} ${caseSymbols[item.status] ?? '·'}`;
    wrap.append(el('span', label, `case-chip ${caseClass(item.status)}`));
  }
  return wrap;
}

function renderWorkersGrid(workers, active, now) {
  const runningJobs = active.filter((entry) => entry.status === 'running');
  const key = JSON.stringify([
    workers.map(({ id, status, lastSeen }) => [id, status, lastSeen]),
    runningJobs.map(({ id, worker, problem, participant, attempts, phase, testsCompleted, testsTotal, testResults, expires, leasePrefix, lastRenewedAt }) => [
      id, worker, problem, participant, attempts, phase, testsCompleted, testsTotal, testResults, expires, leasePrefix, lastRenewedAt,
    ]),
  ]);
  if (key === previousWorkers) return;
  previousWorkers = key;
  const connectedCount = workers.filter((w) => w.status !== 'offline').length;
  byId('workers-badge').textContent = `${connectedCount} conectado${connectedCount === 1 ? '' : 's'}`;
  const grid = byId('workers-grid');
  if (!workers.length) {
    grid.replaceChildren(el('p', 'Nenhum worker conectado. Inicie um worker no terminal para vê-lo aparecer aqui.', 'empty'));
    return;
  }

  grid.replaceChildren(...workers.map((worker) => {
    const job = active.find((entry) => entry.worker === worker.id && entry.status === 'running');
    const card = el('button', undefined, `worker-card ${worker.status}`);
    card.type = 'button';
    card.addEventListener('click', () => setSelectedWorker(worker.id));

    const top = el('div', undefined, 'worker-card-top');
    const state = el('span', undefined, `worker-state ${worker.status}`);
    state.append(el('i', undefined, 'dot'), document.createTextNode(workerLabels[worker.status] ?? worker.status));
    top.append(el('span', worker.id, 'worker-id'), state);
    card.append(top);

    const hbRow = el('div', undefined, 'heartbeat-row');
    const hbTime = job?.lastRenewedAt ?? worker.lastSeen;
    const isPulsing = (pulseUntil.get(worker.id) ?? 0) > Date.now();
    const hbPill = el('span', job?.lastRenewedAt ? formatAgo(job.lastRenewedAt, now) : `Visto ${timeFmt.format(worker.lastSeen)}`, `heartbeat-pill${isPulsing ? ' pulse' : ''}`);
    hbPill.dataset.renewedAt = job?.lastRenewedAt ? String(job.lastRenewedAt) : '';
    hbRow.append(hbPill, el('span', 'Focar ↗'));
    card.append(hbRow);

    if (job) {
      const banner = el('div', undefined, 'job-banner');
      const bannerText = el('div');
      bannerText.append(
        el('strong', job.participant),
        el('small', `Problema ${job.problem} · #${job.id.slice(0, 6)} · Tentativa ${job.attempts}`),
      );
      banner.append(el('span', job.problem, `problem-badge problem-${job.problem}`), bannerText);
      card.append(banner);

      const stepper = el('div', undefined, 'stepper');
      for (const [idx, title] of ['1. Claim', '2. Compilar', '3. Testes', '4. Retorno'].entries()) {
        stepper.append(el('span', title, `step ${stepState(job, idx)}`));
      }
      card.append(stepper);

      if (job.testsTotal > 0) card.append(createCasesChips(job));
      if (job.expires) card.append(createTtlBox(job, now));
    } else {
      const idleMsg = worker.status === 'offline'
        ? 'Worker offline · sem heartbeat recente.'
        : 'Disponível · consultando /internal/claim…';
      card.append(el('div', idleMsg, 'worker-idle-box'));
    }

    return card;
  }));
}

function renderResultCard(job) {
  const li = el('li', undefined, 'result-card');
  const top = el('div', undefined, 'result-top');
  const who = el('div', undefined, 'result-who');
  const meta = el('div');
  meta.append(
    el('strong', job.participant),
    el('small', `${job.worker ?? '—'} · ${job.attempts} tentativa${job.attempts === 1 ? '' : 's'} · ${timeFmt.format(job.finishedAt ?? job.createdAt)}`),
  );
  who.append(el('span', job.problem, `problem-badge problem-${job.problem}`), meta);
  top.append(who, el('span', verdictLabels[job.status] ?? job.status, `verdict ${verdictCategory(job.status)}`));
  li.append(top);
  if (job.testResults?.length) {
    const completed = job.testResults.filter((entry) => entry.status !== 'running');
    if (completed.length) li.append(createCasesChips({ ...job, testResults: completed, testsTotal: completed.length }));
  }
  return li;
}

function renderEventCard(ev) {
  const li = el('li', undefined, 'event-card');
  const body = el('div', undefined, 'event-body');
  const line = el('div', undefined, 'event-line');
  const meta = [];
  if (ev.submissionId) meta.push(`#${ev.submissionId.slice(0, 6)}`);
  if (ev.worker) meta.push(ev.worker);
  if (ev.leasePrefix) meta.push(`lease ${ev.leasePrefix}`);
  if (ev.attempt) meta.push(`tentativa ${ev.attempt}`);
  line.append(
    el('span', eventLabels[ev.type] ?? ev.type, `event-badge ${ev.type}`),
    el('strong', meta.join(' · ') || 'Protocolo'),
  );
  body.append(line);
  if (ev.detail) body.append(el('small', ev.detail));
  li.append(el('time', timeFmt.format(ev.createdAt), 'event-time'), body);
  return li;
}

function renderResultsAndEvents(data) {
  const recent = (data.recentResults ?? []).slice(0, 5);
  const resKey = JSON.stringify(recent);
  if (resKey !== previousResults) {
    previousResults = resKey;
    const resultsList = byId('results-list');
    resultsList.replaceChildren(...(recent.length ? recent.map(renderResultCard) : [el('li', 'Nenhum veredito concluído ainda.', 'empty')]));
  }

  const events = (data.events ?? []).slice(0, 12);
  const evKey = JSON.stringify(events);
  if (evKey !== previousEvents) {
    previousEvents = evKey;
    const eventsList = byId('events-list');
    eventsList.replaceChildren(...(events.length ? events.map(renderEventCard) : [el('li', 'Nenhum evento registrado ainda.', 'empty')]));
  }
}

function renderFocusView(data, now) {
  const worker = data.workers.find((w) => w.id === selectedWorkerId);
  const active = data.activeSubmissions ?? [];
  const job = active.find((entry) => entry.worker === selectedWorkerId && entry.status === 'running');
  const workerResults = (data.submissions ?? [])
    .filter((sub) => sub.worker === selectedWorkerId && !['queued', 'running'].includes(sub.status))
    .slice(0, 6);
  const workerEvents = (data.events ?? [])
    .filter((ev) => ev.worker === selectedWorkerId)
    .slice(0, 15);
  const focusKey = JSON.stringify([selectedWorkerId, worker ?? null, job ?? null, workerResults, workerEvents]);
  if (focusKey === previousFocus) return;
  previousFocus = focusKey;

  byId('focus-worker-name').textContent = selectedWorkerId;
  const status = worker?.status ?? 'offline';
  const stateNode = byId('focus-worker-state');
  stateNode.className = `worker-state ${status}`;
  stateNode.replaceChildren(el('i', undefined, 'dot'), el('span', worker ? (workerLabels[status] ?? status) : 'Aguardando conexão'));

  const hbNode = byId('focus-heartbeat');
  const isPulsing = (pulseUntil.get(selectedWorkerId) ?? 0) > Date.now();
  hbNode.className = `heartbeat-pill${isPulsing ? ' pulse' : ''}`;
  hbNode.dataset.renewedAt = job?.lastRenewedAt ? String(job.lastRenewedAt) : '';
  hbNode.textContent = job?.lastRenewedAt
    ? formatAgo(job.lastRenewedAt, now)
    : worker?.lastSeen ? `Último contato ${timeFmt.format(worker.lastSeen)}` : 'Ainda não conectado';

  const body = byId('focus-body');
  if (job) {
    byId('focus-stage-title').textContent = `${job.participant} · Problema ${job.problem}`;
    byId('focus-task-meta').textContent = `#${job.id.slice(0, 6)} · Tentativa ${job.attempts}`;

    const stepper = el('div', undefined, 'focus-stepper');
    const stepInfos = [
      ['1. Chegada (Claim)', `Reserva atômica · Tentativa ${job.attempts}`],
      ['2. Compilação (Docker)', job.phase === 'compiling' ? 'Compilando g++ -std=c++17…' : job.phase === 'testing' ? 'Binário gerado' : 'Preparando contêiner'],
      ['3. Casos de teste', `${job.testsCompleted} de ${job.testsTotal} concluídos`],
      ['4. Retorno (Finish)', job.testsCompleted >= job.testsTotal && job.testsTotal > 0 ? 'Enviando veredito à API…' : 'Aguardando fim dos testes'],
    ];
    for (const [idx, [title, desc]] of stepInfos.entries()) {
      const box = el('div', undefined, `focus-step ${stepState(job, idx)}`);
      box.append(el('strong', title), el('small', desc));
      stepper.append(box);
    }

    const table = el('table', undefined, 'cases-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const col of ['Caso', 'Status', 'Duração']) headRow.append(el('th', col));
    thead.append(headRow);
    const tbody = el('tbody');
    for (const item of buildCaseList(job)) {
      const tr = el('tr');
      const statusBadge = el('span', `${caseSymbols[item.status] ?? '·'} ${caseStatusLabels[item.status] ?? item.status}`, `case-chip ${caseClass(item.status)}`);
      const statusTd = el('td');
      statusTd.append(statusBadge);
      tr.append(el('td', `Caso ${item.case}`), statusTd, el('td', formatDuration(item.durationMs)));
      tbody.append(tr);
    }
    table.append(thead, tbody);

    const nodes = [stepper];
    if (job.expires) nodes.push(createTtlBox(job, now));
    nodes.push(table);
    body.replaceChildren(...nodes);
  } else {
    byId('focus-stage-title').textContent = worker ? (status === 'offline' ? 'Worker offline' : 'Aguardando próxima submissão') : 'Worker ainda não conectado';
    byId('focus-task-meta').textContent = worker ? (workerLabels[status] ?? status) : 'Desconectado';
    const hint = worker
      ? (status === 'offline'
        ? 'Este worker parou de enviar heartbeats. Se ele caiu no meio de uma tarefa, outro worker assumirá após a expiração do lease.'
        : 'Este worker está conectado e consultando /internal/claim continuamente. Envie uma submissão na Arena para acompanhar o ciclo ao vivo.')
      : `Inicie um processo com WORKER_ID=${selectedWorkerId} para acompanhar esta máquina ao vivo.`;
    body.replaceChildren(el('div', hint, 'worker-idle-box'));
  }

  byId('focus-results').replaceChildren(
    ...(workerResults.length ? workerResults.map(renderResultCard) : [el('li', 'Nenhuma submissão concluída por este worker ainda.', 'empty')]),
  );

  byId('focus-events').replaceChildren(
    ...(workerEvents.length ? workerEvents.map(renderEventCard) : [el('li', 'Nenhum evento registrado para este worker ainda.', 'empty')]),
  );
}

function updateLiveTimers() {
  const now = Date.now() + clockOffset;
  for (const box of document.querySelectorAll('.ttl-box')) {
    const remaining = Math.max(0, Number(box.dataset.expires) - now);
    const seconds = (remaining / 1000).toFixed(1).replace('.', ',');
    const text = box.querySelector('.ttl-text');
    const bar = box.querySelector('.ttl-bar');
    if (text) text.textContent = `TTL restante: ${seconds} s`;
    if (bar) {
      bar.max = leaseMs;
      bar.value = remaining;
    }
    box.classList.toggle('expiring', remaining <= Math.min(3000, leaseMs * 0.3));
  }
  for (const pill of document.querySelectorAll('.heartbeat-pill[data-renewed-at]')) {
    const ts = Number(pill.dataset.renewedAt);
    if (ts > 0) pill.textContent = formatAgo(ts, now);
  }
}

function trackHeartbeats(active) {
  for (const job of active) {
    if (job.status !== 'running' || !job.worker || !job.lastRenewedAt) continue;
    const prev = lastRenewSeen.get(job.worker);
    if (prev !== undefined && job.lastRenewedAt > prev) {
      pulseUntil.set(job.worker, Date.now() + 800);
    }
    lastRenewSeen.set(job.worker, job.lastRenewedAt);
  }
}

function renderAll(data) {
  const now = Date.now() + clockOffset;
  const active = data.activeSubmissions ?? [];
  trackHeartbeats(active);
  renderSelector(data.workers ?? []);
  renderSummary(data);

  const inFocus = Boolean(selectedWorkerId);
  byId('cluster-view').hidden = inFocus;
  byId('focus-view').hidden = !inFocus;

  if (inFocus) {
    renderFocusView(data, now);
  } else {
    renderQueue(active, data.counts);
    renderWorkersGrid(data.workers ?? [], active, now);
    renderResultsAndEvents(data);
  }
  updateLiveTimers();
}

async function poll() {
  try {
    const res = await fetch('/api/dashboard', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data.serverTime === 'number') clockOffset = data.serverTime - Date.now();
    if (data.config?.leaseMs) leaseMs = data.config.leaseMs;
    lastDashboard = data;
    renderAll(data);
    setConnection(true);
  } catch {
    setConnection(false);
  } finally {
    setTimeout(poll, 800);
  }
}

byId('back-to-cluster').addEventListener('click', () => setSelectedWorker(null));
setInterval(updateLiveTimers, 250);
poll();
