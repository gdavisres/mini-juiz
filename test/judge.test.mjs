import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../src/judge.mjs';
import { validProgress } from '../src/problems.mjs';

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

test('validProgress valida testResults opcional e rejeita payloads inconsistentes', () => {
  assert.equal(validProgress({ phase: 'compiling', testsCompleted: 0, testsTotal: 3 }, 'A'), true);
  assert.equal(validProgress({ phase: 'compiling', testsCompleted: 0, testsTotal: 3, testResults: [] }, 'A'), true);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 1, testsTotal: 3,
    testResults: [
      { case: 1, status: 'passed', durationMs: 12 },
      { case: 2, status: 'running', durationMs: null },
    ],
  }, 'A'), true);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 2, testsTotal: 3,
    testResults: [
      { case: 1, status: 'passed', durationMs: 0 },
      { case: 2, status: 'wrong_answer', durationMs: 15 },
    ],
  }, 'A'), true);

  // Casos inválidos
  assert.equal(validProgress({ phase: 'compiling', testsCompleted: 0, testsTotal: 3, testResults: [{ case: 1, status: 'running', durationMs: null }] }, 'A'), false);
  assert.equal(validProgress({ phase: 'testing', testsCompleted: 1, testsTotal: 3, testResults: 'invalido' }, 'A'), false);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 1, testsTotal: 3,
    testResults: [{ case: 2, status: 'passed', durationMs: 5 }],
  }, 'A'), false);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 1, testsTotal: 3,
    testResults: [
      { case: 1, status: 'running', durationMs: null },
      { case: 2, status: 'passed', durationMs: 5 },
    ],
  }, 'A'), false);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 1, testsTotal: 3,
    testResults: [{ case: 1, status: 'passed', durationMs: -1 }],
  }, 'A'), false);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 2, testsTotal: 3,
    testResults: [{ case: 1, status: 'passed', durationMs: 5 }],
  }, 'A'), false);
  assert.equal(validProgress({
    phase: 'testing', testsCompleted: 1, testsTotal: 3,
    testResults: [{ case: 1, status: 'desconhecido', durationMs: 5 }],
  }, 'A'), false);
});

test('judge emite testResults caso-a-caso durante execução e ao falhar', async () => {
  const events = [];
  const compile = async () => ({ code: 0, stdout: Buffer.from('executable') });
  let count = 0;
  const run = async () => {
    count += 1;
    return { code: 0, stdout: Buffer.from(count === 1 ? '11\n' : 'errado\n') };
  };
  const result = await judge(solution, { compile, run }, 'A', async (p) => events.push(p));
  assert.equal(result.status, 'wrong_answer');
  assert.equal(events.length, 5);
  assert.deepEqual(events[0], { phase: 'compiling', testsCompleted: 0, testsTotal: 3, testResults: [] });
  assert.deepEqual(events[1], {
    phase: 'testing', testsCompleted: 0, testsTotal: 3,
    testResults: [{ case: 1, status: 'running', durationMs: null }],
  });
  assert.equal(events[2].testsCompleted, 1);
  assert.equal(events[2].testResults[0].status, 'passed');
  assert.equal(Number.isInteger(events[2].testResults[0].durationMs) && events[2].testResults[0].durationMs >= 0, true);
  assert.equal(events[3].testResults[1].status, 'running');
  assert.equal(events[3].testResults[1].durationMs, null);
  assert.equal(events[4].testsCompleted, 2);
  assert.equal(events[4].testResults[1].status, 'wrong_answer');
  assert.equal(Number.isInteger(events[4].testResults[1].durationMs) && events[4].testResults[1].durationMs >= 0, true);
});

test('o runner Docker compila e executa código C++ em contêineres separados', { skip: !process.env.TEST_DOCKER }, async () => {
  assert.equal((await judge(solution)).status, 'accepted');
  assert.equal((await judge('int main() { for (;;) {} }')).status, 'time_limit');
  assert.equal((await judge('int main(')).status, 'compile_error');
});
