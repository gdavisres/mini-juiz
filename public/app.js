const byId = (id) => document.getElementById(id);
const labels = {
  queued: 'Na fila', running: 'Em correção', accepted: 'Accepted', wrong_answer: 'Wrong Answer',
  compile_error: 'Compilation Error', runtime_error: 'Runtime Error', time_limit: 'Time Limit Exceeded',
  judge_error: 'Erro do juiz', dead_letter: 'Dead Letter',
};
const eventLabels = {
  submitted: 'Submetida', claimed: 'Reservada', reclaimed: 'Retomada',
  stale_rejected: 'Rejeitada (409)', idempotent_replay: 'Idempotente',
  finished: 'Concluída', dead_letter: 'Dead Letter',
};
const burstSource = `#include <bits/stdc++.h>
#include <unistd.h>
using namespace std;

int main() {
    long long a, b;
    cin >> a >> b;
    sleep(1);
    cout << a + b << '\\n';
}
`;
const workerLabels = { online: 'Disponível', busy: 'Corrigindo', offline: 'Offline' };
const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' });
let problems = [];
let problem;
let submitting = false;
let clockOffset = 0;
let leaseMs = 10000;
let previousSubmissions = '';
let previousWorkers = '';
let previousQueue = '';
let previousFeed = '';
let previousEvents = '';
const drafts = new Map();
let sourceEditor = {
  getValue: () => byId('source').value,
  setValue: (value, id = problem?.id) => { if (id === problem?.id) byId('source').value = value; },
  setProblem: (_id, value) => { byId('source').value = value; },
  focus: () => byId('source').focus(),
};
const sourceTemplate = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // Escreva sua solução aqui.

    return 0;
}
`;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function api(path, options) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Erro na comunicação com o juiz.');
  return result;
}

function verdictCategory(status) {
  return ['accepted', 'running', 'queued'].includes(status) ? status : 'failure';
}

function selectProblem(id) {
  const selected = problems.find((item) => item.id === id);
  if (!selected || submitting) return;
  if (problem) drafts.set(problem.id, sourceEditor.getValue());
  problem = selected;
  sourceEditor.setProblem(id, drafts.get(id) ?? sourceTemplate);
  byId('problem-letter').textContent = id;
  byId('problem-title').textContent = problem.title;
  byId('selected-context').textContent = `Problema ${id} · ${problem.title}`;
  byId('editor-problem').textContent = `Problema ${id} · C++17`;
  byId('source-filename').textContent = `solucao-${id}.cpp`;
  for (const key of ['statement', 'input', 'output']) byId(key).textContent = problem[key];
  byId('limits').textContent = `${problem.timeLimit} s · ${problem.memoryLimit} MiB`;
  byId('example-input').textContent = problem.example.input;
  byId('example-output').textContent = problem.example.output;
  for (const button of byId('problem-picker').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.problem === id));
  }
  byId('send').disabled = false;
  message('');
}

function renderProblemPicker() {
  byId('problem-picker').replaceChildren(...problems.map((item) => {
    const button = element('button', undefined, 'problem-choice');
    button.type = 'button';
    button.dataset.problem = item.id;
    button.setAttribute('aria-pressed', 'false');
    const content = element('span', undefined, 'choice-content');
    content.append(element('strong', item.title), element('small', `${item.topic} · ${item.difficulty}`));
    button.append(element('span', item.id, `choice-letter problem-${item.id}`), content);
    button.addEventListener('click', () => selectProblem(item.id));
    return button;
  }));
}

function renderSubmissions(submissions) {
  const key = JSON.stringify(submissions);
  if (key === previousSubmissions) return;
  previousSubmissions = key;
  const tbody = byId('submissions');
  const expanded = new Set([...tbody.querySelectorAll('details[open]')].map((item) => item.dataset.id));
  byId('table-wrap').hidden = !submissions.length;
  byId('submissions-empty').hidden = Boolean(submissions.length);
  byId('submissions-empty').textContent = 'Nenhuma submissão recebida.';
  tbody.replaceChildren(...submissions.map((submission) => {
    const row = element('tr');
    const verdict = element('td');
    const badge = element('span', labels[submission.status], `verdict ${verdictCategory(submission.status)}`);
    if (submission.detail) {
      const details = element('details');
      const summary = element('summary');
      details.dataset.id = submission.id;
      details.open = expanded.has(submission.id);
      summary.append(badge);
      details.append(summary, element('pre', submission.detail));
      verdict.append(details);
    } else verdict.append(badge);
    const problemCell = element('td');
    problemCell.append(element('span', submission.problem, `table-problem problem-${submission.problem}`));
    row.append(problemCell, element('td', submission.participant), verdict, element('td', submission.worker ?? '—'),
      element('td', submission.attempts), element('td', time.format(submission.createdAt)));
    return row;
  }));
}

function renderWorkers(workers, active) {
  const key = JSON.stringify([workers.map(({ id, status }) => [id, status]), active.filter((item) => item.status === 'running')]);
  if (key === previousWorkers) return;
  previousWorkers = key;
  byId('worker-count').textContent = `${workers.filter((worker) => worker.status !== 'offline').length} conectados`;
  byId('worker-list').replaceChildren(...(workers.length ? workers.map(({ id, status }) => {
    const item = element('li', undefined, `worker worker-card ${status}`);
    const header = element('div', undefined, 'worker-card-header');
    const name = element('div', undefined, 'worker-name');
    const machine = element('span', undefined, 'worker-machine');
    machine.setAttribute('aria-hidden', 'true');
    machine.append(element('i'), element('i'));
    name.append(machine, element('strong', id));
    const state = element('span', undefined, 'worker-state');
    const dot = element('i', undefined, 'dot');
    dot.setAttribute('aria-hidden', 'true');
    state.append(dot, document.createTextNode(workerLabels[status]));
    header.append(name, state);
    item.append(header);
    const job = active.find((entry) => entry.worker === id && entry.status === 'running');
    if (job) {
      const body = element('div', undefined, 'worker-task');
      const title = element('div', undefined, 'task-title');
      title.append(element('span', job.problem, `table-problem problem-${job.problem}`), element('strong', job.participant));
      body.append(title);
      const phase = job.phase === 'compiling' ? 'Compilando C++17…'
        : job.phase === 'testing' ? `Executando testes · ${job.testsCompleted}/${job.testsTotal} concluídos` : 'Preparando correção…';
      body.append(element('p', phase, 'task-phase'));
      if (job.phase === 'testing' && job.testsTotal > 0) {
        const progress = element('progress');
        progress.max = job.testsTotal;
        progress.value = job.testsCompleted;
        progress.setAttribute('aria-label', `Testes concluídos de ${job.participant}, problema ${job.problem}`);
        body.append(progress);
      } else {
        const activity = element('div', undefined, 'compile-activity');
        activity.setAttribute('aria-hidden', 'true');
        body.append(activity);
      }
      if (job.expires) {
        const ttl = element('div', undefined, 'lease-ttl');
        ttl.dataset.expires = String(job.expires);
        ttl.dataset.leasePrefix = job.leasePrefix ?? '';
        const ttlText = element('span', '', 'ttl-text');
        const ttlBar = element('progress', undefined, 'ttl-bar');
        ttlBar.max = leaseMs;
        ttlBar.value = Math.max(0, job.expires - (Date.now() + clockOffset));
        ttlBar.setAttribute('aria-label', `Tempo restante da reserva de ${job.participant}`);
        ttl.append(ttlText, ttlBar);
        body.append(ttl);
      }
      body.append(element('small', `Submissão #${job.id.slice(0, 6)} · Tentativa ${job.attempts}`, 'task-id'));
      item.append(body);
    } else {
      item.append(element('p', status === 'offline' ? 'Sem comunicação recente.' : status === 'busy' ? 'Correção em andamento.' : 'Pronto para a próxima submissão.', 'worker-idle'));
    }
    return item;
  }) : [element('li', 'Nenhum worker conectado. Inicie um worker para corrigir as soluções da fila.', 'empty')]));
  updateLeaseCountdowns();
}

function updateLeaseCountdowns() {
  const now = Date.now() + clockOffset;
  for (const node of document.querySelectorAll('.lease-ttl')) {
    const remaining = Math.max(0, Number(node.dataset.expires) - now);
    const seconds = (remaining / 1000).toFixed(1).replace('.', ',');
    const prefix = node.dataset.leasePrefix;
    const text = node.querySelector('.ttl-text');
    const bar = node.querySelector('.ttl-bar');
    if (text) text.textContent = `TTL ${seconds} s${prefix ? ` · lease ${prefix}` : ''}`;
    if (bar) {
      bar.max = leaseMs;
      bar.value = remaining;
    }
    node.classList.toggle('expiring', remaining <= Math.min(3000, leaseMs * 0.3));
  }
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

function renderDistributed(data) {
  const metrics = data.metrics;
  if (metrics) {
    byId('sd-queue-ms').textContent = formatDuration(metrics.avgQueueMs);
    byId('sd-exec-ms').textContent = formatDuration(metrics.avgExecMs);
    byId('sd-reclaims').textContent = String(metrics.reclaims);
    byId('sd-stale').textContent = String(metrics.staleRejections);
    byId('sd-dead').textContent = String(metrics.deadLetters);
  }
  if (data.config) {
    byId('sd-config').textContent = `Lease ${formatDuration(data.config.leaseMs)} · Máx. ${data.config.maxAttempts} tentativas`;
  }
  const events = data.events ?? [];
  const key = JSON.stringify(events);
  if (key === previousEvents) return;
  previousEvents = key;
  byId('event-log').replaceChildren(...(events.length ? events.map((ev) => {
    const item = element('li', undefined, 'event-item');
    const badge = element('span', eventLabels[ev.type] ?? ev.type, `event-badge ${ev.type}`);
    const meta = [];
    if (ev.submissionId) meta.push(`#${ev.submissionId.slice(0, 6)}`);
    if (ev.worker) meta.push(ev.worker);
    if (ev.leasePrefix) meta.push(`lease ${ev.leasePrefix}`);
    if (ev.attempt) meta.push(`tentativa ${ev.attempt}`);
    const body = element('div', undefined, 'event-body');
    const line = element('div', undefined, 'event-line');
    line.append(badge, element('strong', meta.join(' · ') || 'Evento do protocolo'));
    body.append(line);
    if (ev.detail) body.append(element('small', ev.detail));
    item.append(element('time', time.format(ev.createdAt), 'event-time'), body);
    return item;
  }) : [element('li', 'Nenhum evento registrado ainda.', 'empty')]));
}

function renderQueue(active, counts) {
  const queued = active.filter((entry) => entry.status === 'queued');
  const key = JSON.stringify([queued, counts.queued]);
  if (key === previousQueue) return;
  previousQueue = key;
  byId('queue-count').textContent = `${counts.queued} aguardando`;
  const items = queued.slice(0, 4).map((job, index) => {
    const item = element('li', undefined, 'queue-item');
    const info = element('div');
    info.append(element('strong', job.participant), element('small', job.attempts > 0 ? `Problema ${job.problem} · Aguardando retomada` : `Problema ${job.problem} · Aguardando worker`));
    item.append(element('span', String(index + 1).padStart(2, '0'), 'queue-position'), info, element('span', job.problem, `table-problem problem-${job.problem}`));
    return item;
  });
  if (counts.queued > items.length) items.push(element('li', `+ ${counts.queued - items.length} submissões na fila`, 'queue-more'));
  byId('queue-list').replaceChildren(...(items.length ? items : [element('li', 'Nenhuma submissão na fila.', 'empty')]));
}

function renderFeed(submissions) {
  const recent = submissions.filter((item) => !['running', 'queued'].includes(item.status)).slice(0, 4);
  const key = JSON.stringify(recent);
  if (key === previousFeed) return;
  previousFeed = key;
  byId('result-feed').replaceChildren(...(recent.length ? recent.map((job) => {
    const item = element('li', undefined, 'result-item');
    const info = element('div');
    info.append(element('strong', job.participant), element('small', `Problema ${job.problem} · ${time.format(job.finishedAt ?? job.createdAt)}`));
    item.append(element('span', job.status === 'accepted' ? '✓' : '!', `result-symbol ${verdictCategory(job.status)}`), info,
      element('span', labels[job.status], `verdict ${verdictCategory(job.status)}`));
    return item;
  }) : [element('li', 'Os vereditos aparecerão após a correção.', 'empty')]));
}

function setConnection(connected) {
  const status = byId('connection');
  const label = connected ? 'API conectada' : 'API indisponível';
  byId('judge-rail').classList.toggle('is-connected', connected);
  byId('rail-notice').textContent = connected ? '' : 'Sem conexão com o juiz. Exibindo a última atualização recebida.';
  if (status.textContent === label) return;
  status.classList.toggle('connected', connected);
  status.replaceChildren(element('span', undefined, 'dot'), document.createTextNode(label));
}

async function loadDashboard() {
  const data = await api('/api/dashboard');
  if (typeof data.serverTime === 'number') clockOffset = data.serverTime - Date.now();
  if (data.config?.leaseMs) leaseMs = data.config.leaseMs;
  for (const [name, value] of Object.entries(data.counts)) {
    const node = byId(name);
    if (node) node.textContent = value;
  }
  byId('pipeline-queue').textContent = data.counts.queued;
  byId('pipeline-workers').textContent = data.counts.running;
  byId('pipeline-done').textContent = data.counts.accepted;
  const active = data.activeSubmissions ?? data.submissions.filter((item) => ['queued', 'running'].includes(item.status));
  renderSubmissions(data.submissions);
  renderWorkers(data.workers, active);
  renderQueue(active, data.counts);
  renderFeed(data.recentResults ?? data.submissions);
  renderDistributed(data);
  setConnection(true);
}

async function refresh() {
  try {
    if (!problems.length) {
      problems = await api('/api/problems');
      renderProblemPicker();
      selectProblem(problems[0].id);
    }
    await loadDashboard();
  } catch { setConnection(false); }
  finally { setTimeout(refresh, 1100); }
}

function message(text, error = false) {
  byId('message').textContent = text;
  byId('message').classList.toggle('error', error);
}

byId('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const target = problem?.id;
  try {
    if (file.size > 32768) throw new Error('O arquivo precisa ter até 32 KiB.');
    const source = await file.text();
    if (target) {
      drafts.set(target, source);
      sourceEditor.setValue(source, target);
    }
    if (problem?.id === target) {
      message(`Arquivo ${file.name} carregado.`);
    }
  } catch (error) { message(error.message, true); }
  finally { event.target.value = ''; }
});

byId('submission-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId('send');
  if (!problem || button.disabled) return;
  const source = sourceEditor.getValue();
  if (!source.trim()) {
    message('Escreva ou abra uma solução C++ antes de enviar.', true);
    sourceEditor.focus();
    return;
  }
  submitting = true;
  button.disabled = true;
  byId('problem-picker').querySelectorAll('button').forEach((item) => { item.disabled = true; });
  const selectedId = problem.id;
  message(`Enviando solução do problema ${selectedId}…`);
  let sent = false;
  try {
    const form = new FormData(event.currentTarget);
    await api('/api/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant: form.get('participant'), source, problem: selectedId }),
    });
    sent = true;
    message(`Solução do problema ${selectedId} enviada. Acompanhe a central de correção.`);
    await loadDashboard();
  } catch (error) {
    if (sent) {
      setConnection(false);
      message('Solução enviada. A atualização do acompanhamento está temporariamente indisponível.');
    } else message(error.message, true);
  } finally {
    submitting = false;
    button.disabled = false;
    byId('problem-picker').querySelectorAll('button').forEach((item) => { item.disabled = false; });
  }
});

byId('burst-send')?.addEventListener('click', async () => {
  const button = byId('burst-send');
  const status = byId('burst-message');
  if (button.disabled) return;
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Disparando 6 submissões concorrentes (Problema A)…';
  try {
    await Promise.all(Array.from({ length: 6 }, (_, index) => api('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant: `Rajada #${index + 1}`, problem: 'A', source: burstSource }),
    })));
    status.textContent = '6 tarefas enviadas em paralelo. Acompanhe a distribuição entre os workers.';
    await loadDashboard();
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message || 'Não foi possível enviar a rajada.';
  } finally {
    button.disabled = false;
  }
});

async function start() {
  setInterval(updateLeaseCountdowns, 250);
  try {
    const { createSourceEditor } = await import('/editor.js');
    sourceEditor = createSourceEditor({
      textarea: byId('source'), parent: byId('editor-mount'),
      nonce: document.querySelector('meta[name="editor-style-nonce"]').content,
      position: byId('cursor-position'),
    });
  } catch (error) {
    console.error('Editor avançado indisponível:', error);
    byId('editor-mount').replaceChildren();
    byId('editor-mount').hidden = true;
    byId('source').hidden = false;
    byId('source').required = true;
    byId('editor-shortcuts').textContent = 'Editor básico ativo. Você pode escrever ou abrir um arquivo .cpp.';
  }
  refresh();
}

start();
