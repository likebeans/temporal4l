import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  appendFileSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime } from '@temporalio/worker';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const temporalReadyMarker = '__TEMPORAL_E2E_READY__';

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

interface ManagedProcess {
  name: string;
  child: ReturnType<typeof spawn>;
  events: EventEmitter;
  logPath: string;
  output: string;
  exit?: ExitStatus;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function runTemporalServer(namespace: string, dbFilename: string): Promise<void> {
  if (!namespace || !dbFilename) throw new Error('Temporal 子进程缺少 namespace 或数据库路径。');
  Runtime.install({ shutdownSignals: [] });

  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = (): void => resolveStop();
  const keepAlive = setInterval(() => {}, 60_000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let environment: TestWorkflowEnvironment | undefined;
  try {
    environment = await TestWorkflowEnvironment.createLocal({
      server: {
        namespace,
        ip: '127.0.0.1',
        ui: false,
        dbFilename,
        log: { format: 'pretty', level: 'warn' },
      },
    });
    console.log(`${temporalReadyMarker}${JSON.stringify({ address: environment.address, namespace })}`);
    await stopped;
  } finally {
    clearInterval(keepAlive);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await environment?.teardown();
  }
}

function startProcess(
  name: string,
  args: string[],
  logDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): ManagedProcess {
  const logPath = join(logDirectory, `${name}.log`);
  writeFileSync(logPath, '');
  const child = spawn(process.execPath, args, {
    cwd: projectDirectory,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const managed: ManagedProcess = {
    name, child, events: new EventEmitter(), logPath, output: '',
  };

  const record = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    appendFileSync(logPath, text);
    managed.output = `${managed.output}${text}`.slice(-256_000);
    managed.events.emit('output');
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  child.once('error', (error) => {
    record(`\n进程启动错误：${errorMessage(error)}\n`);
    managed.events.emit('output');
  });
  child.once('exit', (code, signal) => {
    managed.exit = { code, signal };
    managed.events.emit('output');
  });
  return managed;
}

function waitForPattern(
  managed: ManagedProcess,
  pattern: RegExp,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, match?: RegExpMatchArray): void => {
      clearTimeout(timer);
      managed.events.off('output', check);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(match!);
    };
    const check = (): void => {
      const match = managed.output.match(pattern);
      if (match) return finish(undefined, match);
      if (managed.exit) {
        finish(new Error(`${managed.name} 在就绪前退出（code=${managed.exit.code}, signal=${managed.exit.signal}）。`));
      }
    };
    const aborted = (): void => finish(new Error('收到退出信号，停止 E2E。'));
    const timer = setTimeout(
      () => finish(new Error(`等待 ${managed.name} 就绪超过 ${timeoutMs / 1_000} 秒。`)),
      timeoutMs,
    );
    managed.events.on('output', check);
    signal.addEventListener('abort', aborted, { once: true });
    check();
  });
}

function waitForExit(managed: ManagedProcess, timeoutMs: number, signal?: AbortSignal): Promise<ExitStatus> {
  if (managed.exit) return Promise.resolve(managed.exit);
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      managed.events.off('output', check);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(managed.exit!);
    };
    const check = (): void => { if (managed.exit) finish(); };
    const aborted = (): void => finish(new Error('收到退出信号，停止 E2E。'));
    const timer = setTimeout(
      () => finish(new Error(`${managed.name} 运行超过 ${timeoutMs / 1_000} 秒。`)),
      timeoutMs,
    );
    managed.events.on('output', check);
    signal?.addEventListener('abort', aborted, { once: true });
    check();
  });
}

function sendSignal(managed: ManagedProcess, signal: NodeJS.Signals): void {
  if (!managed.child.pid) return;
  try {
    if (process.platform === 'win32') managed.child.kill(signal);
    else process.kill(-managed.child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopProcess(managed: ManagedProcess): Promise<void> {
  if (managed.exit) return;
  sendSignal(managed, 'SIGTERM');
  try {
    await waitForExit(managed, 15_000);
  } catch {
    sendSignal(managed, 'SIGKILL');
    await waitForExit(managed, 5_000).catch(() => undefined);
  }
}

async function waitForHealth(
  baseUrl: string,
  worker: ManagedProcess,
  api: ManagedProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let latest = '尚未收到健康检查响应';
  while (Date.now() < deadline) {
    if (worker.exit) throw new Error(`Worker 在健康检查前退出（code=${worker.exit.code}）。`);
    if (api.exit) throw new Error(`API 在健康检查前退出（code=${api.exit.code}）。`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
      latest = await response.text();
      const health = JSON.parse(latest) as { temporal?: boolean; worker?: boolean };
      if (response.ok && health.temporal && health.worker) return;
    } catch (error) {
      latest = errorMessage(error);
    }
    await delay(400, undefined, { signal });
  }
  throw new Error(`API / Worker 在 45 秒内未就绪。最后结果：${latest}`);
}

function preserveFailureLogs(logDirectory: string, failure: unknown): string {
  const artifactDirectory = join(projectDirectory, 'artifacts', 'e2e');
  mkdirSync(artifactDirectory, { recursive: true });
  for (const file of readdirSync(logDirectory)) {
    copyFileSync(join(logDirectory, file), join(artifactDirectory, basename(file)));
  }
  writeFileSync(join(artifactDirectory, 'failure.txt'), `${errorMessage(failure)}\n`);
  return artifactDirectory;
}

async function runIsolatedE2E(): Promise<void> {
  const artifactDirectory = join(projectDirectory, 'artifacts', 'e2e');
  rmSync(artifactDirectory, { recursive: true, force: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'temporal-e2e-'));
  const logDirectory = join(temporaryDirectory, 'logs');
  mkdirSync(logDirectory);

  const namespace = `temporal-e2e-${randomUUID()}`;
  const databasePath = join(temporaryDirectory, 'temporal.sqlite');
  const paymentPath = join(temporaryDirectory, 'payments.sqlite');
  const processes: ManagedProcess[] = [];
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    controller.abort();
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let failure: unknown;
  try {
    console.log(`启动隔离 Temporal（namespace: ${namespace}）…`);
    const temporal = startProcess('temporal', [
      '--import', 'tsx', scriptPath, '--temporal-server', namespace, databasePath,
    ], logDirectory);
    processes.push(temporal);
    const temporalMatch = await waitForPattern(
      temporal,
      new RegExp(`${temporalReadyMarker}([^\\n]+)`),
      90_000,
      controller.signal,
    );
    const { address } = JSON.parse(temporalMatch[1]) as { address: string };

    const serviceEnvironment = {
      ...process.env,
      TEMPORAL_ADDRESS: address,
      TEMPORAL_NAMESPACE: namespace,
      TEMPORAL_UI_URL: 'http://127.0.0.1:0',
      PAYMENT_DB_PATH: paymentPath,
    };
    console.log(`Temporal 已就绪（${address}），启动 Worker…`);
    const worker = startProcess(
      'worker', ['--import', 'tsx', 'server/worker.ts'], logDirectory, serviceEnvironment,
    );
    processes.push(worker);
    await waitForPattern(worker, /Worker 已就绪/, 45_000, controller.signal);

    console.log('Worker 已就绪，启动随机端口 API…');
    const api = startProcess('api', ['--import', 'tsx', 'server/index.ts'], logDirectory, {
      ...serviceEnvironment,
      API_PORT: '0',
    });
    processes.push(api);
    const apiMatch = await waitForPattern(
      api,
      /Server listening at (http:\/\/127\.0\.0\.1:\d+)/,
      30_000,
      controller.signal,
    );
    const baseUrl = apiMatch[1];
    await waitForHealth(baseUrl, worker, api, controller.signal);

    console.log(`API 已就绪（${baseUrl}），运行 8 项真实 E2E…`);
    const tests = startProcess('tests', [
      '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/api.e2e.ts',
    ], logDirectory, { ...serviceEnvironment, DEMO_API_URL: baseUrl });
    processes.push(tests);
    const result = await waitForExit(tests, 180_000, controller.signal);
    if (result.code !== 0) {
      throw new Error(`E2E 测试失败（code=${result.code}, signal=${result.signal}）。`);
    }
    console.log(tests.output.trim());
  } catch (error) {
    failure = error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    for (const managed of [...processes].reverse()) await stopProcess(managed);
  }

  if (failure) {
    const savedAt = preserveFailureLogs(logDirectory, failure);
    console.error(errorMessage(failure));
    for (const managed of processes) {
      const tail = managed.output.slice(-4_000).trim();
      if (tail) console.error(`\n--- ${managed.name} 日志末尾 ---\n${tail}`);
    }
    console.error(`完整失败日志已保存到 ${savedAt}`);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });

  if (failure) process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
  else console.log('隔离 E2E 通过，临时 Temporal、Worker、API 与 SQLite 数据均已清理。');
}

if (process.argv[2] === '--temporal-server') {
  await runTemporalServer(process.argv[3], process.argv[4]);
} else {
  await runIsolatedE2E();
}
