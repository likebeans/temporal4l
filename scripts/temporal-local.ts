import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { config } from '../server/config';

// 官方 SDK 管理项目专用的原生 CLI，无须全局安装或运行 Docker。
const dataDirectory = fileURLToPath(new URL('../.temporal/', import.meta.url));
async function startServer(): Promise<TestWorkflowEnvironment> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await TestWorkflowEnvironment.createLocal({
        server: {
          namespace: config.namespace,
          ip: '127.0.0.1',
          port: 7233,
          ui: true,
          uiPort: 8233,
          dbFilename: `${dataDirectory}learning.db`,
        },
      });
    } catch (error) {
      // SDK 首次下载后的冷启动可能超过内置等待时间；使用缓存自动重试。
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 3 || !message.includes('did not start within')) throw error;
      console.log(`开发服务器启动较慢，正在重试（${attempt}/2）…`);
      await delay(1_000);
    }
  }
  throw new Error('Temporal 启动失败，请检查 7233 和 8233 端口是否被占用。');
}
async function main(): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  console.log('正在启动 Temporal；首次运行会下载官方开发服务器…');
  const environment = await startServer();
  console.log(`Temporal 已就绪：127.0.0.1:7233，namespace：${config.namespace}，官方 UI：http://localhost:8233`);
  let stopping = false;
  const keepAlive = setInterval(() => {}, 60_000);
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    await environment.teardown();
  }
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

// 测试可以导入配置；只有直接执行脚本时才启动服务。
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
