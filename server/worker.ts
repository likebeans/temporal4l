import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { TASK_QUEUE } from '../shared/types';
import { config } from './config';
import * as activities from './activities';

async function main(): Promise<void> {
  console.log(`连接 Temporal ${config.address} / ${config.namespace} ...`);
  const connection = await NativeConnection.connect({ address: config.address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      activities,
      shutdownGraceTime: '10s',
      maxHeartbeatThrottleInterval: '500ms',
    });
    console.log(`Worker 已就绪，监听任务队列 ${TASK_QUEUE}`);
    console.log(`Worker PID: ${process.pid}（恢复实验只操作此进程）`);
    // SDK 会处理 SIGINT / SIGTERM，停止拉取任务并等待正在执行的 Activity 退出。
    await worker.run();
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error('Worker 启动失败。请先核对 Temporal 是否已就绪：原生方式用 npm run temporal:local，Docker 方式用 npm run temporal:up；再检查连接地址与 namespace，并重新启动 Worker。', error);
  process.exitCode = 1;
});
