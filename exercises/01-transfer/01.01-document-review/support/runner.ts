import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import proto from '@temporalio/proto';
import type { temporal } from '@temporalio/proto';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createDocumentReviewActivities } from './activities';
import { documentDatabasePath, DocumentReviewStore } from './store';
import {
  APPROVE_DOCUMENT_SIGNAL,
  DOCUMENT_REVIEW_STATE_QUERY,
  DOCUMENT_REVIEW_TASK_QUEUE,
  DOCUMENT_REVIEW_WORKFLOW,
  documentInputError,
  type DocumentReviewInput,
  type DocumentReviewState,
} from './types';

// 公共配置负责加载 .env；保留调用进程显式传入的环境，避免 .env 覆盖隔离测试或 CLI 配置。
const explicitEnvironment = {
  address: process.env.TEMPORAL_ADDRESS,
  namespace: process.env.TEMPORAL_NAMESPACE,
  databasePath: process.env.DOCUMENT_REVIEW_DB_PATH,
};
const { config: sharedConfig } = await import('../../../../server/config');
const config = {
  address: explicitEnvironment.address || sharedConfig.address,
  namespace: explicitEnvironment.namespace || sharedConfig.namespace,
};
if (explicitEnvironment.databasePath !== undefined) {
  process.env.DOCUMENT_REVIEW_DB_PATH = explicitEnvironment.databasePath;
}

type Variant = 'problem' | 'solution';
type Command = { kind: 'worker' } | { kind: 'help' } | { kind: 'start'; input: DocumentReviewInput }
  | { kind: 'inspect' | 'approve' | 'cancel' | 'result'; workflowId: string; runId: string };

const help = `资料审核练习（从仓库根目录运行）
  npm run exercise:review -- worker
  npm run exercise:review -- start --document demo-001 --timeout 300 [--lose-response]
  npm run exercise:review -- inspect <workflowId> <runId>
  npm run exercise:review -- approve <workflowId> <runId>
  npm run exercise:review -- cancel <workflowId> <runId>
  npm run exercise:review -- result <workflowId> <runId>
参考版本把 exercise:review 换为 exercise:review:solution。
无需根脚本时：npx tsx exercises/01-transfer/01.01-document-review/<problem|solution>/main.ts <命令>
worker 使用独立进程；同一练习队列只允许一个版本的 Worker。result 最多等待 15 秒，可重复执行。
环境：TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE（默认 temporal-learning）/ DOCUMENT_REVIEW_DB_PATH。`;

function parseCommand(args: string[]): Command {
  const [kind, ...rest] = args;
  if (!kind || kind === 'help' || kind === '--help') {
    if (rest.length) throw new Error('help 不接受其他参数');
    return { kind: 'help' };
  }
  if (kind === 'worker') {
    if (rest.length) throw new Error('worker 不接受其他参数');
    return { kind };
  }
  if (kind === 'start') {
    let documentId = '';
    let reviewTimeoutSeconds = 300;
    let losePrepareResponse = false;
    const seen = new Set<string>();
    for (let index = 0; index < rest.length; index += 1) {
      const option = rest[index];
      if (seen.has(option)) throw new Error(`重复参数：${option}`);
      seen.add(option);
      if (option === '--lose-response') {
        losePrepareResponse = true;
      } else if (option === '--document' || option === '--timeout') {
        const value = rest[++index];
        if (!value || value.startsWith('--')) throw new Error(`${option} 缺少值`);
        if (option === '--document') documentId = value;
        else {
          if (!/^\d+$/.test(value)) throw new Error('--timeout 应为整数秒数');
          reviewTimeoutSeconds = Number(value);
        }
      } else throw new Error(`未知 start 参数：${option}`);
    }
    const input = { documentId, reviewTimeoutSeconds, losePrepareResponse };
    const invalid = documentInputError(input);
    if (invalid) throw new Error(invalid);
    return { kind, input };
  }
  if (kind === 'inspect' || kind === 'approve' || kind === 'cancel' || kind === 'result') {
    const [workflowId, runId] = rest;
    if (rest.length !== 2 || !workflowId || workflowId.length > 255 || /[\s\u0000-\u001f]/.test(workflowId)
      || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(runId ?? '')) {
      throw new Error(`${kind} 必须提供完整的 <workflowId> <runId>；不要省略 runId`);
    }
    return { kind, workflowId, runId };
  }
  throw new Error(`未知命令：${kind}；使用 --help 查看用法`);
}

// 锁按服务、namespace、队列隔离，不按 variant 或 SQLite 路径隔离。
// 仅保护本机 CLI；多机器操作必须由操作者保证该队列只有一个练习 Worker。
function acquireWorkerLock(variant: Variant): () => void {
  const key = createHash('sha256').update(`${config.address}\n${config.namespace}\n${DOCUMENT_REVIEW_TASK_QUEUE}`)
    .digest('hex').slice(0, 24);
  const filename = join(tmpdir(), `temporal-document-review-${key}.lock`);
  let descriptor: number;
  try {
    descriptor = openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    // 不自动抢占陈旧锁，避免两个重启进程同时删锁后并行消费。
    throw new Error(`练习队列已有 Worker 锁：${readFileSync(filename, 'utf8')}；先在对应终端正常退出。若上次进程异常退出，仅在确认没有练习 Worker 后手动删除 ${filename}`);
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, variant }));
  } finally {
    closeSync(descriptor);
  }
  return () => unlinkSync(filename);
}

async function runWorker(variant: Variant, workflowsPath: string): Promise<void> {
  const release = acquireWorkerLock(variant);
  let connection: NativeConnection | undefined;
  let store: DocumentReviewStore | undefined;
  try {
    connection = await NativeConnection.connect({ address: config.address });
    store = new DocumentReviewStore(documentDatabasePath());
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: DOCUMENT_REVIEW_TASK_QUEUE,
      identity: `document-review-${variant}-${process.pid}`,
      workflowsPath,
      activities: createDocumentReviewActivities(store),
      shutdownGraceTime: '10 seconds',
      maxHeartbeatThrottleInterval: '500ms',
    });
    console.log(`资料审核 ${variant} Worker 已就绪`);
    console.log(`Worker PID: ${process.pid}（仅在此独立终端 Ctrl+C 退出练习 Worker）`);
    console.log(`Temporal: ${config.address} / ${config.namespace}`);
    console.log(`Task queue: ${DOCUMENT_REVIEW_TASK_QUEUE}`);
    console.log(`SQLite: ${documentDatabasePath()}`);
    // SDK 接管 SIGINT / SIGTERM；完成优雅关闭后才关闭账本、连接与互斥锁。
    await worker.run();
  } finally {
    try { store?.close(); } finally {
      try { await connection?.close(); } finally { release(); }
    }
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause && error.cause !== error ? `；${errorText(error.cause)}` : '';
  return `${error.name}: ${error.message}${cause}`;
}

async function capture<T>(operation: () => Promise<T>): Promise<
  { ok: true; observedAt: string; value: T } | { ok: false; observedAt: string; error: string }
> {
  try {
    const value = await operation();
    return { ok: true, observedAt: new Date().toISOString(), value };
  } catch (error) {
    return { ok: false, observedAt: new Date().toISOString(), error: errorText(error) };
  }
}

type RawEvent = temporal.api.history.v1.IHistoryEvent;

export function documentHistory(events: RawEvent[]): object[] {
  const activities = new Map<string, { activityId: string; activityType: string }>();
  for (const event of events) {
    const scheduled = event.activityTaskScheduledEventAttributes;
    if (scheduled) activities.set(String(event.eventId), {
      activityId: scheduled.activityId ?? '',
      activityType: scheduled.activityType?.name ?? '',
    });
  }
  return events.map((event) => {
    const scheduled = event.activityTaskScheduledEventAttributes;
    const linked = event.activityTaskStartedEventAttributes ?? event.activityTaskCompletedEventAttributes
      ?? event.activityTaskFailedEventAttributes ?? event.activityTaskTimedOutEventAttributes
      ?? event.activityTaskCanceledEventAttributes ?? event.activityTaskCancelRequestedEventAttributes;
    const scheduledEventId = scheduled ? String(event.eventId) : linked?.scheduledEventId?.toString();
    const activity = scheduledEventId ? activities.get(scheduledEventId) : undefined;
    const type = proto.temporal.api.enums.v1.EventType[event.eventType ?? 0];
    const started = event.activityTaskStartedEventAttributes;
    const failure = event.activityTaskFailedEventAttributes?.failure
      ?? event.workflowExecutionFailedEventAttributes?.failure ?? started?.lastFailure;
    return {
      eventId: String(event.eventId),
      type,
      ...(event.eventTime ? { eventTime: {
        seconds: String(event.eventTime.seconds), nanos: event.eventTime.nanos ?? 0,
      } } : {}),
      ...(activity ? { ...activity, scheduledEventId } : {}),
      ...(started ? { attempt: started.attempt, lastFailure: started.lastFailure?.message } : {}),
      ...(event.workflowExecutionSignaledEventAttributes ? {
        signalName: event.workflowExecutionSignaledEventAttributes.signalName,
      } : {}),
      ...(failure ? { failure: failure.message } : {}),
    };
  });
}

async function inspect(client: Client, handle: WorkflowHandle, workflowId: string, runId: string): Promise<void> {
  const deadline = <T>(milliseconds: number, operation: () => Promise<T>): Promise<T> =>
    client.connection.withDeadline(Date.now() + milliseconds, operation);
  const description = await capture(async () => {
    const value = await deadline(5_000, () => handle.describe());
    return {
      workflowId: value.workflowId,
      runId: value.runId,
      workflowType: value.type,
      taskQueue: value.taskQueue,
      status: value.status.name,
      startTime: value.startTime,
      closeTime: value.closeTime,
    };
  });
  const query = await capture(() => deadline(2_000, () => handle.query<DocumentReviewState>(DOCUMENT_REVIEW_STATE_QUERY)));
  // History 必须在 Query 成功/超时之后读取，停机窗口可保存其最后 eventId 作为边界。
  const history = await capture(async () => {
    const value = await deadline(5_000, () => handle.fetchHistory());
    const events = value.events ?? [];
    return { lastEventId: events.at(-1)?.eventId?.toString() ?? '0', events: documentHistory(events) };
  });
  const ledger = await capture(async () => {
    const filename = documentDatabasePath();
    if (!existsSync(filename)) throw new Error(`SQLite 尚不存在：${filename}；确认 Worker 已启动且两端路径一致`);
    const store = new DocumentReviewStore(filename, true);
    try { return { filename, ...store.get(workflowId) }; } finally { store.close(); }
  });
  console.log(JSON.stringify({
    workflowId,
    runId,
    description,
    query: { ...query, source: '本次 RPC；不回退到缓存' },
    history,
    ledger,
    evidenceBoundary: 'Describe / Query / History / SQLite 分开读取，不是原子快照。Query 不可用不证明某 PID 已停止。Signal 入库不等于 handler 已执行。SQLite 幂等键与统计按 Workflow ID 跨 Run 聚合，entries 的 runId/activityId 可关联本 Run 的真实 History；不要复用 Workflow ID。',
  }, null, 2));
}

async function assertExerciseHandle(client: Client, handle: WorkflowHandle): Promise<void> {
  const description = await client.connection.withDeadline(Date.now() + 5_000, () => handle.describe());
  if (description.type !== DOCUMENT_REVIEW_WORKFLOW || description.taskQueue !== DOCUMENT_REVIEW_TASK_QUEUE) {
    throw new Error('目标不是独立资料审核队列中的 documentReviewWorkflow，拒绝操作');
  }
}

export async function runDocumentReviewCli(variant: Variant, workflowsPath: string): Promise<void> {
  try {
    const command = parseCommand(process.argv.slice(2));
    if (command.kind === 'help') { console.log(help); return; }
    if (command.kind === 'worker') { await runWorker(variant, workflowsPath); return; }
    const connection = Connection.lazy({ address: config.address, connectTimeout: '3 seconds' });
    try {
      await connection.ensureConnected();
      const client = new Client({ connection, namespace: config.namespace });
      if (command.kind === 'start') {
        const handle = await connection.withDeadline(Date.now() + 5_000, () => client.workflow.start(DOCUMENT_REVIEW_WORKFLOW, {
          taskQueue: DOCUMENT_REVIEW_TASK_QUEUE,
          workflowId: `document-review-${variant}-${randomUUID()}`,
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          args: [command.input],
        }));
        console.log(JSON.stringify({
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          namespace: config.namespace,
          taskQueue: DOCUMENT_REVIEW_TASK_QUEUE,
          input: command.input,
          note: '编排由当前运行的 Worker 版本决定；保存完整 workflowId/runId 用于全部后续命令。',
        }, null, 2));
        return;
      }
      const handle = client.workflow.getHandle(command.workflowId, command.runId, { followRuns: false });
      if (command.kind === 'inspect') {
        await inspect(client, handle, command.workflowId, command.runId);
        return;
      }
      await assertExerciseHandle(client, handle);
      if (command.kind === 'approve') {
        // 直接向指定 Run 发 Signal，不做 Query 前置校验；停 Worker 时 Server 仍可持久化。
        await connection.withDeadline(Date.now() + 5_000, () => handle.signal(APPROVE_DOCUMENT_SIGNAL));
        console.log(`Signal 已提交：${command.workflowId} / ${command.runId}；用 inspect 核对真实事件和业务处理结果。`);
      } else if (command.kind === 'cancel') {
        await connection.withDeadline(Date.now() + 5_000, () => handle.cancel());
        console.log(`协作取消请求已提交：${command.workflowId} / ${command.runId}；清理与执行终态请用 inspect / result 确认。`);
      } else {
        const result = await connection.withDeadline(Date.now() + 15_000, () => handle.result());
        console.log(JSON.stringify({ workflowId: command.workflowId, runId: command.runId, result }, null, 2));
      }
    } finally {
      await connection.close();
    }
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
