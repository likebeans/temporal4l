import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function fixture(t: TestContext, apiPort?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-vite-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'server'));
  await cp(join(projectDirectory, 'vite.config.ts'), join(directory, 'vite.config.ts'));
  await cp(join(projectDirectory, 'server/config.ts'), join(directory, 'server/config.ts'));
  await symlink(join(projectDirectory, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  if (apiPort !== undefined) {
    await writeFile(join(directory, '.env'), `API_PORT=${apiPort}\nPROXY_TEST_SECRET=root-env-secret\n`);
  }
  // Vite 特有的环境文件不能改变 API 使用的端口。
  await writeFile(join(directory, '.env.local'), 'API_PORT=4991\nPROXY_TEST_SECRET=local-secret\n');
  await writeFile(join(directory, '.env.proxy-test'), 'API_PORT=4992\n');
  await writeFile(join(directory, '.env.proxy-test.local'), 'API_PORT=4993\n');
  await writeFile(join(directory, 'resolve-config.mjs'), `
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { resolveConfig } from 'vite';
Server.prototype.listen = () => { throw new Error('解析 Vite 配置不应监听端口'); };
const resolved = await resolveConfig({ root: process.cwd(), mode: 'proxy-test', logLevel: 'silent' }, 'serve');
const proxy = resolved.server.proxy?.['/api'];
assert.ok(proxy && typeof proxy === 'object');
assert.equal(resolved.env.API_PORT, undefined);
assert.equal(resolved.env.PROXY_TEST_SECRET, undefined);
console.log(JSON.stringify({
  target: proxy.target,
  changeOrigin: proxy.changeOrigin,
  host: resolved.server.host,
  port: resolved.server.port,
  strictPort: resolved.server.strictPort,
}));
`);
  return directory;
}

function childEnvironment(apiPort?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // 仅保留运行 Node 所需的系统环境，避免继承开发者的配置或预加载脚本。
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (apiPort !== undefined) env.API_PORT = apiPort;
  return env;
}

for (const scenario of [
  { name: 'Vite /api 代理默认使用 3001，忽略 Vite 特有环境文件', expectedPort: 3001 },
  { name: 'Vite /api 代理采用项目根 .env 的 API_PORT', rootPort: '4301', expectedPort: 4301 },
  { name: 'Vite /api 代理的显式 API_PORT 优先于根 .env', rootPort: '4301', explicitPort: '4302', expectedPort: 4302 },
]) {
  test(scenario.name, { timeout: 40_000 }, async (t) => {
    const directory = await fixture(t, scenario.rootPort);
    // 全套测试会并发编译 Workflow，为独立子进程保留启动预算。
    const { stdout } = await execute(process.execPath, [join(directory, 'resolve-config.mjs')], {
      cwd: directory,
      env: childEnvironment(scenario.explicitPort),
      timeout: 35_000,
    });
    assert.deepEqual(JSON.parse(stdout), {
      target: `http://127.0.0.1:${scenario.expectedPort}`,
      changeOrigin: true,
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    });
  });
}
