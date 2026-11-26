export const problem = {
  id: 'A', title: 'Soma de dois números', timeLimit: 2, memoryLimit: 128,
  difficulty: 'Iniciante', topic: 'Aritmética',
  statement: 'Dados dois números inteiros A e B, calcule a soma A + B.',
  input: 'Uma linha com dois inteiros A e B, separados por espaço (−10⁹ ≤ A, B ≤ 10⁹).',
  output: 'Imprima um único inteiro com a soma dos dois números.',
  example: { input: '4 7', output: '11' },
};

export const cases = [
  { input: '4 7\n', expected: '11' },
  { input: '-12 5\n', expected: '-7' },
  { input: '1000000000 1000000000\n', expected: '2000000000' },
];

export const problems = [problem, {
  id: 'B', title: 'Maior elemento', timeLimit: 2, memoryLimit: 128,
  difficulty: 'Iniciante', topic: 'Vetores',
  statement: 'Uma equipe registrou N valores inteiros. Encontre o maior valor da sequência.',
  input: 'A primeira linha contém N (1 ≤ N ≤ 100000). A segunda contém N inteiros separados por espaço (−10⁹ ≤ valor ≤ 10⁹).',
  output: 'Imprima um único inteiro: o maior elemento da sequência.',
  example: { input: '5\n-4 7 2 7 -1', output: '7' },
}, {
  id: 'C', title: 'Parênteses balanceados', timeLimit: 1, memoryLimit: 64,
  difficulty: 'Básico', topic: 'Strings e pilhas',
  statement: 'Uma expressão é balanceada quando cada abertura tem um fechamento correspondente, na ordem correta. Determine se a sequência de parênteses dada é balanceada.',
  input: 'Uma linha com uma sequência de 1 a 100000 caracteres, formada somente por ( e ).',
  output: 'Imprima SIM se a sequência for balanceada, ou NAO caso contrário.',
  example: { input: '(()())', output: 'SIM' },
}];

const privateCases = new Map([
  ['A', cases],
  ['B', [
    { input: '5\n-4 7 2 7 -1\n', expected: '7' },
    { input: '4\n-20 -3 -100 -7\n', expected: '-3' },
    { input: '1\n-1000000000\n', expected: '-1000000000' },
    { input: '4\n1000000000 0 -1000000000 999999999\n', expected: '1000000000' },
    { input: `100000\n${Array.from({ length: 100000 }, (_, i) => i - 50000).join(' ')}\n`, expected: '49999' },
  ]],
  ['C', [
    { input: '(()())\n', expected: 'SIM' },
    { input: ')(\n', expected: 'NAO' },
    { input: '(()\n', expected: 'NAO' },
    { input: '()()\n', expected: 'SIM' },
    { input: ')\n', expected: 'NAO' },
    { input: `${'('.repeat(50000)}${')'.repeat(50000)}\n`, expected: 'SIM' },
    { input: `${'('.repeat(50001)}${')'.repeat(49999)}\n`, expected: 'NAO' },
  ]],
]);

export const getProblem = (id) => problems.find((entry) => entry.id === id);
export const getCases = (id) => privateCases.get(id);

const caseStatuses = new Set(['running', 'passed', 'wrong_answer', 'runtime_error', 'time_limit', 'judge_error']);

function validTestResults(testResults, phase, testsCompleted, total) {
  if (testResults === undefined) return true;
  if (!Array.isArray(testResults) || testResults.length > total) return false;
  if (phase === 'compiling') return testResults.length === 0;
  let completed = 0;
  for (let i = 0; i < testResults.length; i += 1) {
    const item = testResults[i];
    if (!item || typeof item !== 'object') return false;
    if (item.case !== i + 1 || !caseStatuses.has(item.status)) return false;
    if (item.status === 'running') {
      if (i !== testResults.length - 1 || item.durationMs !== null) return false;
    } else {
      if (!Number.isInteger(item.durationMs) || item.durationMs < 0) return false;
      completed += 1;
    }
  }
  return completed === testsCompleted;
}

export function validProgress(progress, problemId) {
  const total = getCases(problemId)?.length;
  return Boolean(total && progress && ['compiling', 'testing'].includes(progress.phase)
    && Number.isInteger(progress.testsCompleted) && progress.testsCompleted >= 0
    && progress.testsCompleted <= total && progress.testsTotal === total
    && (progress.phase !== 'compiling' || progress.testsCompleted === 0)
    && validTestResults(progress.testResults, progress.phase, progress.testsCompleted, total));
}
