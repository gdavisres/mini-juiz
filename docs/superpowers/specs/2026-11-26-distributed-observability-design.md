# Design: Observabilidade e Cenários de Sistemas Distribuídos no Mini Juiz

**Data:** 2026-11-26  
**Objetivo:** Preparar o `mini-juiz` para uma apresentação acadêmica focada exclusivamente em **Sistemas Distribuídos** (prazo de 1 semana), tornando visíveis ao vivo os mecanismos do protocolo distribuído e adicionando cenários reproduzíveis de concorrência, partição/atraso de rede e proteção contra falhas repetidas.

---

## 1. Intenção e Motivação

O protótipo atual já implementa conceitos importantes de Sistemas Distribuídos (comunicação HTTP/JSON, reserva atômica de tarefas, lease com renovação periódica, recuperação após falha de worker, rejeição de veredito atrasado com HTTP `409`, idempotência, isolamento em Docker e deploy híbrido na Vercel + Turso).

Porém, durante uma demonstração ao vivo, quase todo esse protocolo acontece "invisível" nos bastidores ou no terminal. O objetivo desta evolução é fazer com que a banca **veja** o protocolo distribuído em tempo real na interface web e consiga observar, além da falha simples (`Ctrl+C`), cenários clássicos de concorrência (*burst*), *fencing token* contra worker atrasado (*split-brain*) e *dead-letter* por excesso de tentativas.

---

## 2. Objetivos, Não-Objetivos e Anti-Objetivos

### Objetivos
1. **Linha do tempo de eventos distribuídos (audit log real):** registrar no banco e exibir ao vivo na interface cada transição relevante do protocolo (`submitted`, `claimed`, `reclaimed`, `stale_rejected`, `idempotent_replay`, `finished`, `dead_letter`).
2. **Contagem regressiva do lease (TTL) ao vivo:** exibir o tempo restante da reserva em cada tarefa em correção, sincronizado com o relógio do servidor (`serverTime`) para evitar desvio de relógio do navegador.
3. **Métricas de Sistemas Distribuídos:** exibir tempo médio de espera na fila, tempo médio de execução, total de retomadas após expiração, total de rejeições `409` (*fencing token*) e total de tarefas em `dead_letter`.
4. **Proteção por limite de tentativas (*dead-letter*):** impedir reexecução infinita quando uma tarefa falha repetidamente ao expirar o lease, movendo-a para o estado terminal `dead_letter` após `MAX_ATTEMPTS` (padrão `3`).
5. **Gerador de rajada (*burst*) na interface:** botão para disparar 6 submissões concorrentes de uma vez, demonstrando exclusão mútua na reserva e balanceamento de carga entre workers.
6. **Injeção controlada de atraso no worker (*fencing token*):** variável de ambiente no worker (`SIMULATE_STALE_MS`) que pausa o envio do resultado após o julgamento, deixando o lease vencer e outro worker assumir, para provar ao vivo a rejeição `409` quando o worker atrasado tenta concluir.

### Não-Objetivos
- Placar no estilo ICPC ou ranking de equipes.
- Novos problemas de programação ou novas linguagens além de C++17.
- Manifestos Kubernetes ou mudanças na orquestração de contêineres.
- Sistema de login/autenticação de participantes.

### Anti-Objetivos
- Quebrar o modo local com SQLite (`node src/server.mjs`), o Docker Compose (`compose.yaml`) ou os testes existentes (`npm test` e `npm run test:editor`).
- Simular eventos ou timers falsos no frontend — toda informação exibida deve vir de estado real persistido no banco.
- Aumentar o número de requisições HTTP por segundo na Vercel/Turso (todo dado novo do painel deve vir na mesma resposta de `GET /api/dashboard`).
- Vazar o token completo de `lease` para o navegador (exibir apenas um prefixo curto de 8 caracteres para observabilidade, mantendo o segredo da reserva restrito à API e ao worker).

---

## 3. Restrições Técnicas

- **Compatibilidade dupla de banco:** todas as alterações de schema, eventos, métricas e `dead_letter` devem funcionar de forma idêntica em `src/store.mjs` (SQLite síncrono via `node:sqlite`) e `src/turso-store.mjs` (Turso/libSQL assíncrono via `@libsql/client`).
- **Migração não-destrutiva:** bancos SQLite e Turso já existentes devem receber as novas colunas e a tabela `events` automaticamente na inicialização, sem apagar submissões existentes.
- **CSP estrita:** `src/app.mjs` aplica `Content-Security-Policy` sem `unsafe-inline` para scripts; toda interatividade nova no frontend deve ficar em `public/app.js` sem handlers inline no HTML.
- **Stateless na Vercel:** nenhum estado de métricas ou eventos pode ficar apenas em memória do processo HTTP; tudo deve ser persistido no banco.

---

## 4. Abordagens Consideradas

1. **Observabilidade do Protocolo Distribuído:** linha do tempo de eventos, countdown de TTL do lease e métricas de SD na interface.
   - *Trade-off:* altíssimo impacto visual e risco mínimo, mas sem novos cenários de falha/carga além do `Ctrl+C` manual.
2. **Laboratório de Caos e Carga:** gerador de rajada, simulação de worker atrasado (*fencing token*) e limite de tentativas (*dead-letter*).
   - *Trade-off:* aprofunda muito a defesa técnica, mas sem a visualização da opção 1 parte da prova ficaria escondida no terminal.
3. **Orquestração / Infraestrutura (Kubernetes / Compose multi-worker):**
   - *Trade-off:* útil se a disciplina cobrasse DevOps, mas arriscado para demonstrar ao vivo no Windows e não aproveita o deploy atual na Vercel.

**Abordagem escolhida:** **Opção 1 combinada com os recursos enxutos da Opção 2** (rajada concorrente, injeção de atraso para `409` e *dead-letter*). Escolhida pelo usuário por caber com folga em 1 semana, rodar direto na Vercel + Turso já em produção e tornar todos os conceitos de Sistemas Distribuídos visíveis ao vivo.

---

## 5. Arquitetura e Comportamento Detalhado

### 5.1. Modelo de Dados (`src/store.mjs` e `src/turso-store.mjs`)

- **Novas colunas em `submissions`:**
  - `first_claimed_at INTEGER` — preenchida apenas na primeira reserva (`COALESCE(first_claimed_at, ?)`), usada para calcular tempo de espera inicial na fila (`first_claimed_at - created_at`).
  - `claimed_at INTEGER` — atualizada a cada reserva, usada para calcular o tempo de execução da tentativa vencedora (`finished_at - claimed_at`).
- **Nova tabela `events`:**
  ```sql
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    submission_id TEXT,
    worker TEXT,
    lease_prefix TEXT,
    attempt INTEGER,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS events_created ON events(created_at DESC, id DESC);
  ```
- **Tipos de evento registrados:**
  - `submitted` — nova submissão entrou na fila.
  - `claimed` — worker reservou a tarefa pela primeira vez (`attempt = 1`).
  - `reclaimed` — worker retomou uma tarefa cuja reserva anterior expirou (`attempt > 1`).
  - `stale_rejected` — API rejeitou (`409`) um `renew` ou `finish` com reserva expirada ou inválida (`detail` informa a operação, ex.: `finish rejeitado (409)` ou `renew rejeitado (409)`).
  - `idempotent_replay` — API recebeu repetição idêntica de `finish` para uma tarefa já concluída com o mesmo `lease` e `status`.
  - `finished` — tarefa concluída com veredito final (`detail` traz o status, ex.: `accepted`).
  - `dead_letter` — tarefa encerrada por atingir o limite de `MAX_ATTEMPTS` após expiração de reserva.
- **Decisão:** renovações normais bem-sucedidas (`renew`) **não** geram linhas na tabela `events` para não poluir a linha do tempo nem gerar escritas excessivas no Turso a cada 2,5 s.

### 5.2. Limite de Tentativas (*Dead-Letter*)

- Novo parâmetro `maxAttempts` (env `MAX_ATTEMPTS`, padrão `3`, inteiro >= 1).
- Novo status terminal `'dead_letter'` (exibido na UI como `Dead Letter`).
- Antes de reservar a próxima tarefa em `claim(worker)` — e também durante a leitura de `dashboard()` — o store promove para `dead_letter` qualquer submissão com `status = 'running' AND expires <= now AND attempts >= maxAttempts`, gravando `finished_at = now`, `expires = NULL`, `detail = 'Limite de <N> tentativas atingido após expiração de reserva'` e registrando o evento `dead_letter` para cada submissão promovida.
- Em `claim(worker)`, a subquery de seleção restringe tarefas expiradas a `attempts < maxAttempts`.

### 5.3. Contrato da API (`GET /api/dashboard` e `publicSubmission`)

- Cada submissão pública passa a incluir:
  - `expires`: timestamp em ms quando `status === 'running'` e não expirado; caso contrário `null`.
  - `leasePrefix`: primeiros 8 caracteres do `lease` atual (ou `null`), nunca o token completo.
- `GET /api/dashboard` passa a incluir (no mesmo batch de leitura, sem round-trips extras):
  - `serverTime`: `Date.now()` do servidor.
  - `config`: `{ leaseMs, maxAttempts }`.
  - `counts`: adiciona `deadLetter`.
  - `metrics`:
    - `avgQueueMs`: média de `first_claimed_at - created_at` (inteiro ou `null` se não houver dados).
    - `avgExecMs`: média de `finished_at - claimed_at` para submissões finalizadas != `dead_letter` (inteiro ou `null`).
    - `reclaims`: contagem de eventos `type = 'reclaimed'`.
    - `staleRejections`: contagem de eventos `type = 'stale_rejected'`.
    - `idempotentReplays`: contagem de eventos `type = 'idempotent_replay'`.
    - `deadLetters`: contagem de submissões com `status = 'dead_letter'`.
  - `events`: últimos 30 eventos ordenados por `id DESC`.

### 5.4. Injeção de Atraso no Worker (`src/worker.mjs`)

- Nova variável de ambiente opcional `SIMULATE_STALE_MS` (padrão `0`, desativada).
- Quando `SIMULATE_STALE_MS > 0`:
  1. O worker executa `judge(...)` normalmente.
  2. Ao terminar o julgamento, encerra o loop de renovação do lease (`controller.abort()`), exibe no console que está simulando atraso de rede por `SIMULATE_STALE_MS` ms e aguarda esse tempo.
  3. Após a espera (com o lease já expirado e possivelmente já concluído por outro worker), envia `POST /internal/jobs/:id/finish` com o lease antigo — gerando um `409` real na API e o evento `stale_rejected` visível ao vivo no painel.

### 5.5. Interface Web (`public/index.html`, `public/app.js`, `public/app.css`)

- **Countdown do Lease na Central de Correção (`#judge-rail`):**
  - Ao receber `dashboard`, o frontend calcula `clockOffset = data.serverTime - Date.now()`.
  - Um intervalo leve de 250 ms atualiza o texto/barra de TTL nos cards ativos (`TTL 8,4 s · lease a1b2c3d4`) sem fazer novas chamadas à rede.
- **Nova seção "Sistemas Distribuídos" (`#distribuido`, com link na sidebar):**
  - **Faixa de métricas de SD:** Espera média na fila, Execução média, Retomadas, Rejeições `409`, Dead-letter.
  - **Botão "Simular rajada (6 tarefas)":** dispara 6 requisições `POST /api/submissions` em paralelo com uma solução C++17 válida do Problema A (com pausa curta por caso, igual ao `examples/soma.cpp`, participantes `Rajada #1` a `Rajada #6`), mostrando o balanceamento entre workers e a fila drenando ao vivo.
  - **Linha do tempo de eventos distribuídos:** lista dos últimos 30 eventos com hora, badge colorido por tipo (`submitted`, `claimed`, `reclaimed`, `stale_rejected`, `idempotent_replay`, `finished`, `dead_letter`), worker, prefixo do lease, tentativa e detalhe.

---

## 6. O que Fica a Cargo da Implementação

- Detalhes visuais (cores dos badges de eventos, barra de progresso do TTL e layout responsivo) respeitando o tema claro existente em `public/app.css`.
- Otimização das queries SQL de métricas dentro do `batch` de `src/turso-store.mjs`.
- Cobertura de testes unitários e de integração em `test/` para SQLite, Turso e fluxo HTTP (incluindo `reclaimed`, `stale_rejected`, `idempotent_replay`, `dead_letter` e `metrics`).
- Atualização do `README.md` com o roteiro ampliado da apresentação (incluindo o comando do worker atrasado com `SIMULATE_STALE_MS`).
