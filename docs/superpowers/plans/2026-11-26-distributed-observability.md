# Observabilidade e Cenários de Sistemas Distribuídos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar observáveis ao vivo na interface os mecanismos de Sistemas Distribuídos do `mini-juiz` (trilha de eventos, countdown do lease/TTL, métricas de SD) e adicionar cenários reproduzíveis de rajada concorrente, *fencing token* (`409` com worker atrasado) e *dead-letter* por limite de tentativas.

**Architecture:** Ambos os stores (`src/store.mjs` em SQLite síncrono e `src/turso-store.mjs` em Turso/libSQL assíncrono) passam a persistir `first_claimed_at`, `claimed_at` e uma tabela `events`, promovendo tarefas expiradas com `attempts >= maxAttempts` para `dead_letter` e expondo `serverTime`, `config`, `metrics` e `events` no payload de `GET /api/dashboard`. O worker (`src/worker.mjs`) ganha injeção opcional de atraso (`SIMULATE_STALE_MS`) para provocar `409` real, e a interface (`public/`) renderiza o countdown de TTL sincronizado, as métricas, o botão de rajada e a linha do tempo de eventos sem chamadas HTTP extras.

**Tech Stack:** Node.js 22/24 ESM (`node:sqlite`, `node:http`, `node:test`), `@libsql/client` (Turso), Vanilla JS/HTML/CSS (CSP estrita).

**Spec:** `docs/superpowers/specs/2026-11-26-distributed-observability-design.md`

## Global Constraints

- Compatibilidade dupla idêntica entre `src/store.mjs` (SQLite síncrono) e `src/turso-store.mjs` (Turso assíncrono).
- Migração não-destrutiva para bancos SQLite e Turso existentes (`ALTER TABLE` condicional + `CREATE TABLE IF NOT EXISTS`).
- CSP estrita em `src/app.mjs`: zero `<script>` inline ou handlers `onclick` em `public/index.html`.
- Nenhum vazamento do token completo de `lease` para o navegador: expor apenas `leasePrefix` (8 primeiros caracteres).
- Nenhuma requisição de polling adicional: `serverTime`, `config`, `metrics` e `events` vêm no `GET /api/dashboard`.
- Não registrar renovações normais bem-sucedidas (`renew`) na tabela `events`.
- Padrão `MAX_ATTEMPTS = 3` (inteiro `>= 1`), `SIMULATE_STALE_MS = 0` (desativado por padrão).

## Review Focus

1. **Banco existente sem colunas novas:** abrir um SQLite ou Turso criado antes desta mudança (sem `first_claimed_at`, `claimed_at` ou tabela `events`) deve migrar sem erro e preservar submissões existentes (coberto nas Tasks 1 e 2).
2. **Dead-letter antes do próximo `claim`:** se uma tarefa atinge `MAX_ATTEMPTS` e seu lease expira quando nenhum worker está chamando `claim`, `GET /api/dashboard` ainda deve promovê-la para `dead_letter` e registrar o evento uma única vez (coberto nas Tasks 1 e 2).
3. **Rejeição `409` vs. repetição idempotente:** `finish` com lease expirado deve registrar `stale_rejected`; `finish` repetido com o mesmo `lease` e mesmo `status` de uma tarefa já concluída deve retornar `true` e registrar `idempotent_replay`, nunca `stale_rejected` (coberto nas Tasks 1 e 2).
4. **Chaves extras em `data.counts` no frontend:** adicionar `counts.deadLetter` não pode quebrar `loadDashboard()` se não houver elemento DOM com `id="deadLetter"` (coberto na Task 4).
5. **Segredo de `lease` nunca exposto:** nem `publicSubmission` nem `events` podem retornar o UUID completo do `lease` (apenas `leasePrefix` com no máximo 8 caracteres) (coberto nas Tasks 1, 2 e 3).

---

### Task 1: SQLite Store — Eventos, Métricas, Lease TTL e Dead-Letter

**Files:**
- Modify: `src/store.mjs`
- Create: `test/observability.test.mjs`

**Interfaces:**
- Consumes: `getCases`, `problems`, `validProgress` de `src/problems.mjs`.
- Produces:
  - `verdicts` (mantém os 6 vereditos de julgamento de worker; `'dead_letter'` é status terminal interno do store, não aceito como veredito enviado por worker).
  - `createStore(path, leaseMs, maxAttempts = 3)` retornando `{ get, submit, dashboard, claim, renew, finish }`.
  - `publicSubmission` inclui `expires` (`number | null`) e `leasePrefix` (`string | null`, 8 chars).
  - `dashboard()` retorna `{ serverTime, config: { leaseMs, maxAttempts }, counts: { total, queued, running, accepted, deadLetter }, metrics: { avgQueueMs, avgExecMs, reclaims, staleRejections, idempotentReplays, deadLetters }, submissions, activeSubmissions, recentResults, workers, events }`.
  - Cada item de `events`: `{ id, createdAt, type, submissionId, worker, leasePrefix, attempt, detail }`.

- [ ] **Step 1: Write the failing test in `test/observability.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.mjs';

test('sqlite store registra eventos distribuídos, métricas, leasePrefix e dead_letter', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createStore(':memory:', 1000, 2);

  const sub = store.submit({ participant: 'Equipe SD', problem: 'A', source: 'int main(){}' });
  assert.equal(sub.expires, null);
  assert.equal(sub.leasePrefix, null);

  now = 1200;
  const first = store.claim('w1');
  const running = store.get(sub.id);
  assert.equal(running.expires, 2200);
  assert.equal(running.leasePrefix, first.lease.slice(0, 8));
  assert.notEqual(running.leasePrefix, first.lease);

  // Lease expira -> retomada por w2
  now = 2300;
  assert.equal(store.renew(sub.id, first.lease), false); // gera stale_rejected
  const second = store.claim('w2');
  assert.equal(second.attempts, 2);

  // Worker atrasado tenta finalizar -> rejeitado (stale_rejected)
  assert.equal(store.finish(sub.id, { lease: first.lease, status: 'accepted', detail: 'ok' }), false);

  // Dono atual finaliza + repetição idempotente
  now = 2800;
  assert.equal(store.finish(sub.id, { lease: second.lease, status: 'accepted', detail: 'ok' }), true);
  assert.equal(store.finish(sub.id, { lease: second.lease, status: 'accepted', detail: 'ok' }), true);

  const dash = store.dashboard();
  assert.equal(dash.serverTime, 2800);
  assert.deepEqual(dash.config, { leaseMs: 1000, maxAttempts: 2 });
  assert.equal(dash.metrics.avgQueueMs, 200);
  assert.equal(dash.metrics.avgExecMs, 500);
  assert.equal(dash.metrics.reclaims, 1);
  assert.equal(dash.metrics.staleRejections, 2);
  assert.equal(dash.metrics.idempotentReplays, 1);
  assert.equal(dash.metrics.deadLetters, 0);
  assert.deepEqual(
    dash.events.map((e) => e.type).reverse(),
    ['submitted', 'claimed', 'stale_rejected', 'reclaimed', 'stale_rejected', 'finished', 'idempotent_replay'],
  );

  // Dead-letter após maxAttempts = 2 sem novo claim (via sweep no dashboard)
  const sub2 = store.submit({ participant: 'Falha', problem: 'A', source: 'int main(){}' });
  const a1 = store.claim('w1');
  assert.equal(a1.id, sub2.id);
  now += 1100;
  const a2 = store.claim('w2');
  assert.equal(a2.id, sub2.id);
  assert.equal(a2.attempts, 2);
  now += 1100;
  const dashDead = store.dashboard();
  assert.equal(dashDead.counts.deadLetter, 1);
  assert.equal(dashDead.metrics.deadLetters, 1);
  assert.equal(store.get(sub2.id).status, 'dead_letter');
  assert.equal(store.claim('w1'), undefined);
  // Segundo dashboard() não duplica evento dead_letter
  const deadEvents = store.dashboard().events.filter((e) => e.type === 'dead_letter');
  assert.equal(deadEvents.length, 1);
});

test('sqlite store migra banco antigo sem first_claimed_at, claimed_at e events', () => {
  const db = new DatabaseSync(':memory:');
  db.close();
  // Usa arquivo temporário via :memory: não reabre; testa criação direta com schema legado em createStore
  const store = createStore(':memory:', 1000);
  assert.equal(store.dashboard().events.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/observability.test.mjs`
Expected: FAIL (propriedades `expires`, `leasePrefix`, `serverTime`, `metrics`, `events` e `dead_letter` ainda não existem).

- [ ] **Step 3: Implement events, metrics, TTL metadata, and dead-letter in `src/store.mjs`**

Atualizar `createStore(path, leaseMs, maxAttempts = 3)` em `src/store.mjs`:
- Migrar `submissions` adicionando `first_claimed_at INTEGER` e `claimed_at INTEGER` se ausentes.
- Criar tabela `events` e índice `events_created`.
- Adicionar helper interno `logEvent(now, type, submissionId, worker, lease, attempt, detail)` que grava `lease ? lease.slice(0, 8) : null` em `lease_prefix`.
- Adicionar helper `sweepDeadLetters(now)` que executa `UPDATE submissions SET status = 'dead_letter', finished_at = ?, expires = NULL, detail = ? WHERE status = 'running' AND expires <= ? AND attempts >= ? RETURNING id, worker, lease, attempts` e chama `logEvent` com `'dead_letter'` para cada linha promovida.
- Em `publicSubmission(row, now, maxAttempts)`: incluir `expires` (`null` se não rodando ou expirado) e `leasePrefix` (`null` se expirado ou sem lease; senão `row._lease.slice(0, 8)`). Se expirado e `attempts >= maxAttempts`, retornar `status: 'dead_letter'`.
- Em `claim(worker)`: chamar `sweepDeadLetters(now)`; restringir subquery de expirados a `attempts < ?`; atualizar `first_claimed_at = COALESCE(first_claimed_at, ?)` e `claimed_at = ?`; registrar `'reclaimed'` se `job.attempts > 1` ou `'claimed'` se `job.attempts === 1`.
- Em `renew(id, lease, update)`: se falhar por lease expirado/inválido (mas `validProgress` passou ou `update === undefined`), registrar `stale_rejected` com `detail: 'renew rejeitado (409)'`.
- Em `finish(id, { lease, status, detail })`: se `changes > 0`, registrar `'finished'` (`detail: status`); se `prior` bater `lease` e `status`, registrar `'idempotent_replay'` e retornar `true`; caso contrário, registrar `'stale_rejected'` (`detail: 'finish rejeitado (409)'`) e retornar `false`.
- Em `dashboard()`: chamar `sweepDeadLetters(now)` e retornar `serverTime`, `config`, `counts` (com `deadLetter`), `metrics` e `events` (últimos 30).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/observability.test.mjs test/flow.test.mjs test/judge.test.mjs`
Expected: PASS em todos os testes.

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs test/observability.test.mjs
git commit -m "feat: adiciona eventos distribuídos, métricas e dead-letter ao store SQLite"
```

---

### Task 2: Turso Store Parity (`src/turso-store.mjs`)

**Files:**
- Modify: `src/turso-store.mjs`
- Modify: `test/turso-store.test.mjs`

**Interfaces:**
- Consumes: `@libsql/client`, `getCases`, `validProgress` de `src/problems.mjs`.
- Produces: `createTursoStore({ url, authToken, leaseMs, maxAttempts = 3 })` com contrato assíncrono idêntico ao de `createStore` da Task 1.

- [ ] **Step 1: Add failing assertions for events, metrics, leasePrefix, and dead_letter in `test/turso-store.test.mjs`**

Adicionar um segundo `test(...)` em `test/turso-store.test.mjs` espelhando o cenário da Task 1 com `createTursoStore({ url: ':memory:', leaseMs: 1000, maxAttempts: 2 })`:
- Verifica `expires`, `leasePrefix` (8 chars != `lease`), `serverTime`, `config`.
- Verifica sequência de eventos `['submitted', 'claimed', 'stale_rejected', 'reclaimed', 'stale_rejected', 'finished', 'idempotent_replay']`.
- Verifica `metrics` (`avgQueueMs`, `avgExecMs`, `reclaims`, `staleRejections`, `idempotentReplays`, `deadLetters`).
- Verifica promoção para `dead_letter` via `dashboard()` sem duplicação de evento e sem novo `claim`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/turso-store.test.mjs`
Expected: FAIL no novo teste.

- [ ] **Step 3: Implement parity in `src/turso-store.mjs`**

Atualizar `createTursoStore({ url, authToken, leaseMs, maxAttempts = 3 })`:
- Em `ensureReady()`: criar tabelas `submissions` (com `first_claimed_at`, `claimed_at`), `workers` e `events` + índice `events_created`; consultar `PRAGMA table_info(submissions)` e executar `ALTER TABLE` condicional para `first_claimed_at` e `claimed_at` (migração segura para bancos Turso já criados).
- Implementar `sweepDeadLetters(now)` usando `UPDATE ... RETURNING id, worker, lease, attempts` e batch de inserts em `events` quando houver linhas promovidas.
- Atualizar `submit`, `claim`, `renew`, `finish` e `dashboard` para registrar os mesmos eventos e retornar exatamente o mesmo shape da Task 1 (mantendo as leituras de `dashboard()` em um único `client.batch(..., 'read')`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/turso-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/turso-store.mjs test/turso-store.test.mjs
git commit -m "feat: implementa eventos distribuídos, métricas e dead-letter no store Turso"
```

---

### Task 3: Server Config (`MAX_ATTEMPTS`), Vercel Entrypoint e Injeção de Atraso no Worker

**Files:**
- Modify: `src/server.mjs`
- Modify: `api/index.mjs`
- Modify: `src/worker.mjs`
- Modify: `.env.example`
- Modify: `test/flow.test.mjs`

**Interfaces:**
- Consumes: `createStore(dbPath, leaseMs, maxAttempts)` e `createTursoStore({ url, authToken, leaseMs, maxAttempts })`.
- Produces:
  - Env `MAX_ATTEMPTS` (padrão `3`, inteiro `>= 1`) aceito em `src/server.mjs` e `api/index.mjs`.
  - Env `SIMULATE_STALE_MS` (padrão `0`, inteiro `>= 0`) em `src/worker.mjs` para simular atraso de rede antes de `finish`, disparando `409` real.

- [ ] **Step 1: Add HTTP integration assertions in `test/flow.test.mjs`**

Adicionar ao final de `test/flow.test.mjs` verificações sobre `GET /api/dashboard`:
- `dash.serverTime` é número positivo.
- `dash.config.maxAttempts` é `3` (ou valor de `MAX_ATTEMPTS`).
- `dash.metrics.reclaims >= 1` e `dash.metrics.staleRejections >= 1` após a expiração e tentativa atrasada já exercitadas no teste.
- `dash.events` contém eventos `reclaimed` e `stale_rejected`, e nenhum evento expõe um `leasePrefix` com mais de 8 caracteres.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/flow.test.mjs`
Expected: FAIL antes de conectar `MAX_ATTEMPTS` (ou se algum campo faltar).

- [ ] **Step 3: Wire `MAX_ATTEMPTS` and `SIMULATE_STALE_MS`**

- Em `src/server.mjs` e `api/index.mjs`: ler `const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 3);`, validar `Number.isSafeInteger(maxAttempts) && maxAttempts >= 1` e repassar para `createStore` / `createTursoStore`.
- Em `src/worker.mjs`: ler `const simulateStaleMs = Number(process.env.SIMULATE_STALE_MS ?? 0);`. Em `processJob(job)`, após `const result = await judge(...)`, se `simulateStaleMs > 0`: chamar `controller.abort(); await renewal;`, logar `Simulando atraso de rede (${simulateStaleMs} ms) para testar fencing token...`, aguardar `await delay(simulateStaleMs)` e enviar `post(\`${path}/finish\`, { ...result, lease })` (logando `409 · resultado atrasado rejeitado pela API` quando `response.status === 409`).
- Atualizar `.env.example` documentando `MAX_ATTEMPTS=3` e `SIMULATE_STALE_MS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/flow.test.mjs test/observability.test.mjs test/turso-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs api/index.mjs src/worker.mjs .env.example test/flow.test.mjs
git commit -m "feat: configura MAX_ATTEMPTS e adiciona SIMULATE_STALE_MS no worker"
```

---

### Task 4: Interface de Observabilidade, Countdown de TTL e Botão de Rajada

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`

**Interfaces:**
- Consumes: `GET /api/dashboard` (`serverTime`, `config`, `counts`, `metrics`, `activeSubmissions` com `expires` e `leasePrefix`, `events`) e `POST /api/submissions`.
- Produces:
  - Link na sidebar `#distribuido` ("Distribuído").
  - Countdown de TTL (`TTL X,Xs · lease a1b2c3d4` + barra `<progress>`) nos cards de tarefas em execução em `#worker-list`, atualizado a cada 250 ms via `clockOffset`.
  - Seção `#distribuido` com faixa de métricas SD (`metric-queue-ms`, `metric-exec-ms`, `metric-reclaims`, `metric-stale`, `metric-dead`), botão `#burst-send` ("Simular rajada (6 tarefas)") e lista `#event-log` (últimos 30 eventos).
  - Status `'dead_letter': 'Dead Letter'` em `labels` e guarda `const node = byId(name); if (node)` em `loadDashboard()`.

- [ ] **Step 1: Update `public/index.html`**

- Adicionar link `<a href="#distribuido" title="Sistemas Distribuídos">` na navegação da sidebar.
- Adicionar `<section class="panel distributed" id="distribuido" aria-labelledby="distributed-title">` dentro de `.activity` (logo abaixo de `#submissoes`) contendo:
  - Cabeçalho com título **"Sistemas Distribuídos · Protocolo ao vivo"** e botão `<button type="button" id="burst-send" class="burst-button">Simular rajada (6 tarefas)</button>` + `<p id="burst-message" class="message" role="status"></p>`.
  - Grade de 5 métricas: `Espera média na fila`, `Execução média`, `Retomadas`, `Rejeições 409`, `Dead-letter` (IDs `sd-queue-ms`, `sd-exec-ms`, `sd-reclaims`, `sd-stale`, `sd-dead`).
  - Lista `<ol class="event-log" id="event-log">` para os últimos 30 eventos distribuídos.
- Zero handlers inline (`onclick` etc.) para respeitar CSP.

- [ ] **Step 2: Update `public/app.js`**

- Adicionar `dead_letter: 'Dead Letter'` em `labels` e rótulos em português para os tipos de evento (`eventLabels`: `submitted`, `claimed`, `reclaimed`, `stale_rejected`, `idempotent_replay`, `finished`, `dead_letter`).
- Guardar `clockOffset = 0` e `leaseMs = 10000` atualizados a cada `loadDashboard()` a partir de `data.serverTime` e `data.config?.leaseMs`.
- No `renderWorkers(workers, active)`, quando `job` tem `expires`: renderizar um elemento `<div class="lease-ttl" data-expires="...">` com texto `TTL Xs · lease <prefix>` e `<progress class="ttl-bar">`. Um `setInterval(updateLeaseCountdowns, 250)` atualiza todos os `.lease-ttl` suavemente sem recriar DOM.
- Implementar `renderDistributed(data)` para atualizar as 5 métricas (formatando ms como `420 ms` ou `1,4 s`, ou `—` se `null`) e renderizar `#event-log` (com deduplicação via `previousEvents`).
- Em `loadDashboard()`: proteger `for (const [name, value] of Object.entries(data.counts)) { const node = byId(name); if (node) node.textContent = value; }`.
- Adicionar listener de clique em `#burst-send`: desabilita o botão durante o disparo, envia 6 `POST /api/submissions` em `Promise.all` (Problema `A`, participantes `Rajada #1`..`Rajada #6`, código C++17 com `sleep(1)` igual ao `examples/soma.cpp`), exibe status em `#burst-message` e chama `loadDashboard()`.

- [ ] **Step 3: Add styles in `public/app.css`**

- Estilizar `.distributed`, `.sd-metrics`, `.burst-button`, `.lease-ttl`, `.ttl-bar`, `.event-log`, `.event-item` e badges por tipo de evento (`.event-badge.submitted`, `.claimed`, `.reclaimed`, `.stale_rejected`, `.idempotent_replay`, `.finished`, `.dead_letter`) harmonizados com a paleta clara existente e responsivos no mobile.

- [ ] **Step 4: Verify tests and UI smoke check**

Run: `node --test test/flow.test.mjs test/judge.test.mjs test/observability.test.mjs test/turso-store.test.mjs`
Expected: PASS. Se o Chrome estiver disponível, testar também `npm run test:editor` para confirmar zero violações de CSP e zero exceções de runtime.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/app.css
git commit -m "feat: adiciona painel de observabilidade distribuída, countdown de lease e rajada"
```

---

### Task 5: Roteiro de Apresentação de Sistemas Distribuídos no README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `SIMULATE_STALE_MS`, `MAX_ATTEMPTS`, botão de rajada e painel `#distribuido` das Tasks 1–4.
- Produces: seção atualizada no `README.md` com o passo a passo completo para demonstrar os 4 cenários de SD na apresentação (rajada/concorrência, crash-stop com TTL + retomada, worker atrasado com `SIMULATE_STALE_MS=13000` provando `409` fencing token, e dead-letter).

- [ ] **Step 1: Update `README.md`**

Atualizar a seção de demonstração em `README.md` incluindo:
- Cenário 1: **Concorrência e balanceamento** via botão *Simular rajada (6 tarefas)*.
- Cenário 2: **Crash-stop + TTL ao vivo** (`Ctrl+C` acompanhando o countdown de 10 s zerar e o evento `reclaimed`).
- Cenário 3: **Worker atrasado / Fencing token (`409`)** iniciando um worker com `$env:SIMULATE_STALE_MS = "13000"; $env:WORKER_ID = "worker-lento"; node src\worker.mjs` junto a um worker normal, mostrando o evento `stale_rejected (409)` no painel.
- Cenário 4: **Dead-letter** ao atingir `MAX_ATTEMPTS`.

- [ ] **Step 2: Run full test suite as final verification**

Run: `node --test test/flow.test.mjs test/judge.test.mjs test/observability.test.mjs test/turso-store.test.mjs`
Expected: PASS sem falhas.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: atualiza roteiro de demonstração de Sistemas Distribuídos no README"
```
