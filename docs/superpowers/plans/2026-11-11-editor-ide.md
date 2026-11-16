# Editor C++ com recursos de IDE

Pedido: Tab insere espaços, cores para palavras reservadas, autocomplete e comportamento de editor de código. Preservar tema claro, template, rascunhos A/B/C, upload e envio.

Abordagem: CodeMirror 6 com linguagem C++, indentação de quatro espaços, números de linha, fechamento de delimitadores, destaque de pares, busca, histórico, sugestões de palavras e snippets. Alternativa de implementar isso manualmente no textarea descartada pela complexidade de seleção, histórico e acessibilidade. Monaco acrescentaria infraestrutura desnecessária ao projeto atual. Autocomplete local; não prometer análise semântica de compilador.

## Implementação

- [x] Gerar bundle ESM local reproduzível, com dependências de desenvolvimento fixadas em lockfile e licenças preservadas; aplicação e Docker continuam executando sem npm em produção.
- [x] Módulo do editor com documentos/seleção/histórico separados por problema; textarea sincronizado como campo de formulário e fallback.
- [x] Tab/Shift+Tab, Enter, autocomplete por digitação/Ctrl+Espaço, snippets, cores C++, status de linha/coluna e saída de foco com Esc seguido de Tab.
- [x] Ajustar assets da API e CSP de estilos com nonce por resposta, mantendo scripts e recursos locais.
- [x] Verificar antes/depois no Chrome: Tab e Enter reais, sugestões/aceitação, cores, pares, undo, troca de problema, upload e conteúdo enviado; responsividade e ausência de violações de CSP.
- [x] Suíte existente e revisão independente. Documentar como reconstruir o bundle e usar atalhos.

## Verificação e revisão

- RED inicial: navegador confirma ausência de editor de IDE. GREEN: editor CodeMirror servido localmente.
- `npm run build:editor`: bundle reproduzível e licenças completas de 18 pacotes.
- `npm run test:editor`: Chrome headless usando API em memória; teclas reais, autocomplete explícito e automático, snippets/campos, cores, linhas, indentação multilinha, busca, histórico separado, upload, envio exato, validação de código vazio, fallback e layouts 320–1600 px. Nenhuma violação de CSP.
- Revisão independente: corrigidos Tab/Shift+Tab em campos de snippets e upload concluído com problema inativo. Ambas as regressões reproduzidas RED e verificadas GREEN no script de navegador.
- `node --test`: 8 aprovados, 2 testes Docker excluídos nesta alteração de editor. `node --check public/app.js` e `git diff --check` aprovados.
- CSP: nonce aleatório por documento para estilos do editor; atributos de estilo permitidos para geometria de seleção/sugestões. Scripts continuam restritos à mesma origem.
- README documenta atalhos, natureza local do autocomplete, reconstrução do bundle e teste opcional com Chrome.
