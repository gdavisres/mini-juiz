import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getCases, getProblem } from './problems.mjs';

export const runnerImage = process.env.RUNNER_IMAGE ?? 'minijuiz-runner:local';

async function dockerRun(mode, input, problem) {
  const name = `minijuiz-${randomUUID()}`;
  const compiling = mode === 'compile';
  const memory = compiling ? '384m' : `${problem.memoryLimit}m`;
  const args = ['run', '--rm', '-i', '--init', '--name', name, '--pull=never', '--network=none',
    '--read-only', '--tmpfs', '/work:rw,exec,nosuid,nodev,size=16m,mode=1777',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32',
    '--memory', memory, '--memory-swap', memory, '--cpus=1', '--log-driver=none',
    runnerImage, mode, String(problem.timeLimit)];
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const output = { stdout: [], stderr: [] };
      let size = 0;
      let failure;
      const stop = (message) => {
        failure ??= new Error(message);
        child.kill();
      };
      const deadline = setTimeout(() => stop('O comando Docker excedeu seu limite de tempo.'), compiling ? 30000 : 12000);
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          size += chunk.length;
          if (size <= 1024 * 1024) output[stream].push(chunk);
          else stop('A saída do contêiner excedeu o limite.');
        });
      }
      child.once('error', (error) => { failure ??= error; });
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error.message); });
      child.once('close', (code) => {
        clearTimeout(deadline);
        if (failure || code === null) return reject(failure ?? new Error('Docker encerrou por sinal.'));
        resolve({ code, stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr) });
      });
      child.stdin.end(input);
    });
  } catch (error) {
    await new Promise((resolve) => execFile('docker', ['rm', '-f', name], { timeout: 4000, windowsHide: true }, resolve));
    throw error;
  }
}

const dockerRunner = {
  compile: (source, problem) => dockerRun('compile', source, problem),
  run: (binary, input, problem) => dockerRun('run', Buffer.concat([Buffer.from(`${binary.length}\n`), binary, Buffer.from(input)]), problem),
};

export async function judge(source, runner = dockerRunner, problemId = 'A', onProgress = async () => {}) {
  try {
    const problem = getProblem(problemId);
    const cases = getCases(problemId);
    if (!problem || !cases) return { status: 'judge_error' };
    const results = [];
    const report = (phase, testsCompleted) => onProgress({
      phase, testsCompleted, testsTotal: cases.length,
      testResults: results.map((entry) => ({ ...entry })),
    });
    await report('compiling', 0);
    const compiled = await runner.compile(source, problem);
    if (compiled.code === 125 || compiled.code === 126 || compiled.code === 127) return { status: 'judge_error' };
    if (compiled.code !== 0) return { status: 'compile_error', detail: compiled.stderr?.toString('utf8').slice(0, 1600) };
    if (!compiled.stdout.length) return { status: 'judge_error' };

    for (const [index, test] of cases.entries()) {
      results.push({ case: index + 1, status: 'running', durationMs: null });
      await report('testing', index);
      const startedAt = performance.now();
      const result = await runner.run(compiled.stdout, test.input, problem);
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const detail = `Caso ${index + 1} de ${cases.length}`;
      let caseStatus = 'passed';
      if (result.code === 125 || result.code === 126 || result.code === 127) caseStatus = 'judge_error';
      else if (result.code === 124 || result.code === 137) caseStatus = 'time_limit';
      else if (result.code !== 0) caseStatus = 'runtime_error';
      else if (result.stdout.toString('utf8').trim() !== test.expected) caseStatus = 'wrong_answer';
      results[index] = { case: index + 1, status: caseStatus, durationMs };
      await report('testing', index + 1);
      if (caseStatus === 'judge_error') return { status: 'judge_error' };
      if (caseStatus !== 'passed') return { status: caseStatus, detail };
    }
    return { status: 'accepted', detail: `${cases.length} casos aprovados` };
  } catch (error) {
    console.error('Falha no runner:', error.message);
    return { status: 'judge_error' };
  }
}
