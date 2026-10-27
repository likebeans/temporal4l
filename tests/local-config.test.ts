import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function fixture(t: TestContext): Promise<{ directory: string; namespace: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-local-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await cp(join(projectDirectory, 'scripts/temporal-local.ts'), join(directory, 'scripts/temporal-local.ts'));
  await cp(join(projectDirectory, 'server'), join(directory, 'server'), { recursive: true });
  await cp(join(projectDirectory, 'shared'), join(directory, 'shared'), { recursive: true });
  await symlink(join(projectDirectory, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const namespace = `native-config-${randomUUID()}`;
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(directory, '.env'), `TEMPORAL_NAMESPACE=${namespace}\nAPI_PORT=0\n`);
  return { directory, namespace };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TEMPORAL_NAMESPACE;
  delete env.API_PORT;
  return env;
}

test('原生启动从项目 .env 创建自定义 namespace，并打印实际 namespace', { timeout: 50_000 }, async (t) => {
  const { directory, namespace } = await fixture(t);
  const preload = join(directory, 'isolate-native.mjs');
  await writeFile(preload, `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { TestWorkflowEnvironment } from '@temporalio/testing';
const createLocal = TestWorkflowEnvironment.createLocal;
TestWorkflowEnvironment.createLocal = async (options) => {
  assert.equal(options.server.namespace, ${JSON.stringify(namespace)}, '原生启动必须读取与 API / Worker 相同的 .env namespace');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const environment = await createLocal.call(TestWorkflowEnvironment, {
    ...options,
    server: { ...options.server, port, ui: false, uiPort: undefined },
  });
  await environment.client.workflowService.describeNamespace({ namespace: ${JSON.stringify(namespace)} });
  setTimeout(() => process.emit('SIGTERM'), 100);
  return environment;
};
`);
  const { stdout } = await execute(process.execPath, [
    '--import', 'tsx', '--import', preload, join(directory, 'scripts/temporal-local.ts'),
  ], { cwd: projectDirectory, env: childEnvironment(), timeout: 45_000 });
  assert.ok(stdout.includes(namespace), stdout);
});

test('导入配置与服务入口不会监听端口、创建数据库目录或注册退出信号', { timeout: 30_000 }, async (t) => {
  const { directory } = await fixture(t);
  const check = join(directory, 'check-imports.mjs');
  await writeFile(check, `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Server } from 'node:net';
import { TestWorkflowEnvironment } from '@temporalio/testing';
const signals = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
Server.prototype.listen = () => { throw new Error('导入入口不应监听端口'); };
TestWorkflowEnvironment.createLocal = async () => { throw new Error('导入入口不应启动 Temporal'); };
await import('./server/config.ts');
await import('./scripts/temporal-local.ts');
await import('./server/index.ts');
assert.equal(existsSync(new URL('./.temporal/', import.meta.url)), false);
assert.equal(existsSync(new URL('./.data/', import.meta.url)), false);
assert.deepEqual(['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)), signals);
`);
  // 全套测试同时编译多个 Workflow，子进程启动也需要预算；副作用仍由脚本内断言检查。
  await execute(process.execPath, ['--import', 'tsx', check], {
    cwd: projectDirectory, env: childEnvironment(), timeout: 25_000,
  });
});
