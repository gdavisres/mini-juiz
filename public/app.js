const byId = (id) => document.getElementById(id);
const labels = {
  queued: 'Na fila', running: 'Em correção', accepted: 'Accepted', wrong_answer: 'Wrong Answer',
  compile_error: 'Compilation Error', runtime_error: 'Runtime Error', time_limit: 'Time Limit Exceeded', judge_error: 'Erro do juiz',
};
const workerLabels = { online: 'Disponível', busy: 'Corrigindo', offline: 'Offline' };
const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' });
let problem;
let previousSubmissions = '';
let previousWorkers = '';

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

function renderSubmissions(submissions) {
  const key = JSON.stringify(submissions);
  if (key === previousSubmissions) return;
  previousSubmissions = key;
  const tbody = byId('submissions');
  const expanded = new Set([...tbody.querySelectorAll('details[open]')].map((item) => item.dataset.id));
  byId('table-wrap').hidden = !submissions.length;
  byId('submissions-empty').hidden = Boolean(submissions.length);
  byId('submissions-empty').textContent = 'Nenhuma submissão enviada.';
  tbody.replaceChildren(...submissions.map((submission) => {
    const row = element('tr');
    const verdict = element('td');
    const { status } = submission;
    const category = ['accepted', 'running', 'queued'].includes(status) ? status : 'failure';
    const badge = element('span', labels[status], `verdict ${category}`);
    if (submission.detail) {
      const details = element('details');
      const summary = element('summary');
      details.dataset.id = submission.id;
      details.open = expanded.has(submission.id);
      summary.append(badge);
      details.append(summary, element('pre', submission.detail));
      verdict.append(details);
    } else verdict.append(badge);
    row.append(element('td', submission.participant), verdict, element('td', submission.worker ?? '—'),
      element('td', submission.attempts), element('td', time.format(submission.createdAt)));
    return row;
  }));
}

function renderWorkers(workers) {
  const key = JSON.stringify(workers.map(({ id, status }) => [id, status]));
  if (key === previousWorkers) return;
  previousWorkers = key;
  byId('worker-list').replaceChildren(...(workers.length ? workers.map(({ id, status }) => {
    const item = element('li', undefined, `worker ${status}`);
    const state = element('span');
    state.append(element('i', undefined, 'dot'), document.createTextNode(workerLabels[status]));
    item.append(element('strong', id), state);
    return item;
  }) : [element('li', 'Nenhum worker conectado.', 'empty')]));
}

function setConnection(connected) {
  const status = byId('connection');
  const label = connected ? 'API conectada' : 'API indisponível';
  if (status.textContent === label) return;
  status.classList.toggle('connected', connected);
  status.replaceChildren(element('span', undefined, 'dot'), document.createTextNode(label));
}

async function refresh() {
  try {
    if (!problem) {
      problem = await api('/api/problem');
      byId('problem-letter').textContent = problem.id;
      byId('problem-title').textContent = problem.title;
      for (const key of ['statement', 'input', 'output']) byId(key).textContent = problem[key];
      byId('limits').textContent = `${problem.timeLimit} s · ${problem.memoryLimit} MiB`;
      byId('example-input').textContent = problem.example.input;
      byId('example-output').textContent = problem.example.output;
      byId('send').disabled = false;
    }
    const data = await api('/api/dashboard');
    for (const [name, value] of Object.entries(data.counts)) byId(name).textContent = value;
    renderSubmissions(data.submissions);
    renderWorkers(data.workers);
    setConnection(true);
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
  try {
    if (file.size > 32768) throw new Error('O arquivo precisa ter até 32 KiB.');
    byId('source').value = await file.text();
    message(`Arquivo ${file.name} carregado.`);
  } catch (error) { message(error.message, true); }
  finally { event.target.value = ''; }
});

byId('submission-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId('send');
  if (!problem || button.disabled) return;
  button.disabled = true;
  message('Enviando…');
  try {
    const form = new FormData(event.currentTarget);
    await api('/api/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant: form.get('participant'), source: form.get('source'), problem: problem.id }),
    });
    message('Solução enviada. Acompanhe o veredito nas submissões recentes.');
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});

refresh();
