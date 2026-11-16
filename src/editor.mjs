import { basicSetup } from 'codemirror';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentMore, indentLess } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { indentUnit, syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language';
import { autocompletion, acceptCompletion, snippetCompletion, completeAnyWord, nextSnippetField, prevSnippetField } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

const words = [
  'alignas', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'constexpr',
  'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'false', 'float', 'for',
  'if', 'int', 'long', 'namespace', 'new', 'nullptr', 'private', 'public', 'return', 'short',
  'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true',
  'try', 'typedef', 'typename', 'unsigned', 'using', 'virtual', 'void', 'while',
].map((label) => ({ label, type: 'keyword' }));
const standardLibrary = [
  ['cin', 'variable', 'Entrada padrão'], ['cout', 'variable', 'Saída padrão'],
  ['cerr', 'variable', 'Saída de erros'], ['endl', 'constant', 'Quebra de linha e flush'],
  ['std', 'namespace', 'Biblioteca padrão'], ['string', 'class', 'Texto'],
  ['vector', 'class', 'Vetor dinâmico'], ['pair', 'class', 'Par de valores'],
  ['map', 'class', 'Mapa ordenado'], ['unordered_map', 'class', 'Mapa hash'],
  ['set', 'class', 'Conjunto ordenado'], ['unordered_set', 'class', 'Conjunto hash'],
  ['queue', 'class', 'Fila'], ['priority_queue', 'class', 'Fila de prioridade'],
  ['stack', 'class', 'Pilha'], ['deque', 'class', 'Fila dupla'],
  ['sort', 'function', 'Ordenar intervalo'], ['reverse', 'function', 'Inverter intervalo'],
  ['lower_bound', 'function', 'Busca binária: limite inferior'],
  ['upper_bound', 'function', 'Busca binária: limite superior'],
  ['binary_search', 'function', 'Buscar em intervalo ordenado'],
  ['min', 'function', 'Menor valor'], ['max', 'function', 'Maior valor'],
  ['abs', 'function', 'Valor absoluto'], ['swap', 'function', 'Trocar valores'],
  ['getline', 'function', 'Ler uma linha'], ['push_back', 'function', 'Adicionar ao vetor'],
  ['begin', 'function', 'Início do intervalo'], ['end', 'function', 'Fim do intervalo'],
  ['size', 'function', 'Tamanho'], ['empty', 'function', 'Verificar se vazio'],
].map(([label, type, detail]) => ({ label, type, detail }));
const snippets = [
  snippetCompletion('for (int ${i} = 0; ${i} < ${n}; ++${i}) {\n    ${}\n}', { label: 'for', type: 'keyword', detail: 'Trecho: laço contado', boost: 1 }),
  snippetCompletion('if (${}) {\n    ${}\n}', { label: 'if', type: 'keyword', detail: 'Trecho: condição', boost: 1 }),
  snippetCompletion('while (${}) {\n    ${}\n}', { label: 'while', type: 'keyword', detail: 'Trecho: laço condicional', boost: 1 }),
];

export function cppCompletions(context) {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/Comment|String|CharLiteral/.test(node.name)) return null;
  const word = context.matchBefore(/[A-Za-z_]\w*/);
  if (!word && !context.explicit) return null;
  const local = completeAnyWord(context);
  const options = [...snippets, ...words, ...standardLibrary];
  const known = new Set(options.map(({ label }) => label));
  for (const option of local?.options ?? []) {
    if (!known.has(option.label)) { options.push(option); known.add(option.label); }
  }
  return { from: word?.from ?? context.pos, options, validFor: /^\w*$/ };
}

export const cppHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#8851b4' },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: '#147887' },
  { tag: [tags.string, tags.character], color: '#27865d' },
  { tag: [tags.number, tags.bool, tags.null], color: '#af7024' },
  { tag: tags.comment, color: '#7c8ca5', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: '#3269c7' },
  { tag: tags.operator, color: '#536b92' },
  { tag: tags.meta, color: '#a37336' },
]);

export function createSourceEditor({ textarea, parent, nonce, position }) {
  const states = new Map();
  let currentProblem;
  const updatePosition = (state) => {
    const cursor = state.selection.main.head;
    const line = state.doc.lineAt(cursor);
    position.textContent = 'Ln ' + line.number + ', Col ' + (cursor - line.from + 1);
  };
  const extensions = [
    basicSetup, cpp(), indentUnit.of('    '), EditorState.tabSize.of(4),
    EditorView.cspNonce.of(nonce),
    syntaxHighlighting(cppHighlight),
    autocompletion({ override: [cppCompletions], activateOnTyping: true }),
    Prec.highest(keymap.of([{
      key: 'Tab',
      run(view) {
        if (acceptCompletion(view)) return true;
        if (nextSnippetField(view)) return true;
        if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
        const cursor = view.state.selection.main.head;
        const column = cursor - view.state.doc.lineAt(cursor).from;
        view.dispatch(view.state.replaceSelection(' '.repeat(4 - column % 4)), { userEvent: 'input.indent' });
        return true;
      },
      shift: (view) => prevSnippetField(view) || indentLess(view),
    }])),
    EditorView.contentAttributes.of({
      'aria-label': 'Código C++', 'aria-describedby': 'editor-shortcuts',
      spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        textarea.value = update.state.doc.toString();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (update.docChanged || update.selectionSet) updatePosition(update.state);
    }),
  ];
  const view = new EditorView({ state: EditorState.create({ doc: textarea.value, extensions }), parent });
  textarea.hidden = true;
  textarea.required = false;
  parent.hidden = false;
  updatePosition(view.state);
  return {
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),
    setProblem(id, content) {
      if (currentProblem === id) return;
      if (currentProblem) states.set(currentProblem, view.state);
      currentProblem = id;
      view.setState(states.get(id) ?? EditorState.create({ doc: content, extensions }));
      textarea.value = view.state.doc.toString();
      updatePosition(view.state);
    },
    setValue(content, id = currentProblem) {
      if (id !== currentProblem) {
        const previous = states.get(id);
        states.set(id, previous ? previous.update({
          changes: { from: 0, to: previous.doc.length, insert: content }, selection: { anchor: 0 },
        }).state : EditorState.create({ doc: content, extensions }));
        return;
      }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0 } });
    },
  };
}
