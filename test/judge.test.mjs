import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../src/judge.mjs';

const solution = '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}';

test('a correção exige a resposta exata em todos os casos', async () => {
  const run = async (_binary, input) => {
    const [a, b] = input.trim().split(' ').map(Number);
    return { code: 0, stdout: Buffer.from(`${a + b}\n`) };
  };
  const compile = async () => ({ code: 0, stdout: Buffer.from('executable') });
  assert.equal((await judge(solution, { compile, run })).status, 'accepted');
  assert.equal((await judge(solution, { compile, run: async () => ({ code: 0, stdout: Buffer.from('11\n') }) })).status, 'wrong_answer');
});

test('a correção distingue falhas de compilação, tempo e execução', async () => {
  const compile = async () => ({ code: 0, stdout: Buffer.from('executable') });
  for (const [code, status] of [[124, 'time_limit'], [7, 'runtime_error'], [125, 'judge_error']]) {
    const result = await judge(solution, { compile, run: async () => ({ code }) });
    assert.equal(result.status, status);
  }
  const failure = await judge(solution, { compile: async () => ({ code: 1, stderr: Buffer.from('g++: erro') }) });
  assert.deepEqual(failure, { status: 'compile_error', detail: 'g++: erro' });
});

test('o runner Docker compila e executa código C++ em contêineres separados', { skip: !process.env.TEST_DOCKER }, async () => {
  assert.equal((await judge(solution)).status, 'accepted');
  assert.equal((await judge('int main() { for (;;) {} }')).status, 'time_limit');
  assert.equal((await judge('int main(')).status, 'compile_error');
});
