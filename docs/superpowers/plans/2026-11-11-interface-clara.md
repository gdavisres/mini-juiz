# Interface clara e moderna — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dar ao Mini Juiz uma apresentação clara, moderna e profissional.

**Architecture:** Preservar o aplicativo estático servido pelo backend Node e todos os IDs usados na integração. Reformular HTML e CSS sem bibliotecas ou recursos externos.

**Tech Stack:** HTML, CSS, JavaScript, Node.js.

**Spec:** docs/superpowers/specs/2026-11-11-interface-clara.md

## Global Constraints

- Direção escolhida pelo usuário: visual claro e moderno.
- Manter IDs consumidos pelo JavaScript e dados reais da API.
- Não alterar backend, protocolo de correção ou implantar em outro serviço.

## Review Focus

- Telas estreitas: conteúdo deve caber sem rolagem horizontal na página.
- Teclado: navegação, upload e envio com foco visível.
- Dados vazios: orientação útil sem indicadores fictícios.
- Desconexão: estado perceptível por texto, além de cor.
- Conteúdo longo: nomes e código não devem expandir o layout.

### Task 1: Reformular a apresentação

**Files:** public/index.html, public/app.css.

**Interfaces:** Preservar os IDs usados em public/app.js; consumir as mesmas rotas da API.

- [x] Reorganizar cabeçalho, navegação, métricas e painéis com textos claros e elementos semânticos.
- [x] Implementar tema claro, componentes consistentes e breakpoints para desktop, tablet e celular.
- [x] Conferir IDs, links internos, foco e estados existentes; manter lógica de submissão.

### Task 2: Validar

**Files:** public/app.js, test/flow.test.mjs, test/judge.test.mjs.

- [x] Executar node --check public/app.js e node --test.
- [x] Conferir diff e validar DOM e estilos no navegador, se disponível.
- [x] Reportar limites de verificação e resultado local.

## Registro de execução

- Implementação visual limitada a public/index.html e public/app.css. Sem alteração de backend ou JavaScript.
- Verificação: node --test → 3 aprovados, 1 teste Docker desativado; node --check public/app.js → aprovado.
- Chrome headless com API em memória: navegação por teclado, foco do upload, upload real, envio, fila, exibição de Accepted após retorno simulado do worker, workers e desconexão aprovados.
- Layouts 320, 375, 480, 768, 980, 1280 e 1440 px conferidos; menu e botão acessíveis, sem rolagem horizontal da página.
- Revisão independente identificou mensagem de upload com nome longo sem quebra. Reprodução RED no Chrome com arquivo de 160 caracteres; adicionada overflow-wrap:anywhere; repetição GREEN.
- Ruling: manter alterações no checkout fornecido e não criar commits ou publicar — tarefa solicita reformulação local da interface; não há necessidade de modificar o fluxo Git ou o serviço de hospedagem.
