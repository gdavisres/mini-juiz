export const problem = {
  id: 'A', title: 'Soma de dois números', timeLimit: 2, memoryLimit: 128,
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
