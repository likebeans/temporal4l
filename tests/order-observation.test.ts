import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mock, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Connection } from '@temporalio/client';
import proto from '@temporalio/proto';
import { APPROVE_SIGNAL, WORKFLOW_TYPE, type OrderDetail } from '../shared/types';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const workflowId = 'learning-order-00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';

function deadlineOf(connection: Connection): number {
  const deadline = connection.callContextStorage.getStore()?.deadline;
  assert.ok(deadline !== undefined, 'Temporal RPC 必须有 deadline');
  return deadline instanceof Date ? deadline.getTime() : deadline;
}

// 子进程预加载此文件，只替换外部 SDK RPC；HTTP、SDK handle、deadline 上下文与 History 转换均真实执行。
if (process.env.TEMPORAL_ORDER_OBSERVATION_FIXTURE === '1') {
  const events = proto.temporal.api.history.v1.History.fromObject({ events: [{
    eventId: 1,
    eventType: proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
    eventTime: { seconds: 1_700_000_000 },
    workflowExecutionStartedEventAttributes: { workflowType: { name: WORKFLOW_TYPE } },
  }] }).events;
  process.on('message', (message) => {
    if (message !== 'record-approval-signal') return;
    events.push(proto.temporal.api.history.v1.HistoryEvent.fromObject({
      eventId: 2,
      eventType: proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED,
      eventTime: { seconds: Math.floor(Date.now() / 1_000) },
      workflowExecutionSignaledEventAttributes: { signalName: APPROVE_SIGNAL },
    }));
    process.send?.('signal-recorded');
  });
  process.channel?.unref();

  const lazy = Connection.lazy;
  mock.method(Connection, 'lazy', (options: Parameters<typeof Connection.lazy>[0]) => {
    const connection = lazy.call(Connection, options);
    mock.method(connection, 'ensureConnected', async () => {});
    mock.method(connection.workflowService, 'describeWorkflowExecution', async () => {
      // 慢 Describe 也消耗总预算；Query 若在此后重新获得 4 秒，History 将赶不上外层 6 秒期限。
      await delay(2_200);
      return proto.temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse.fromObject({
        workflowExecutionInfo: {
          execution: { workflowId, runId },
          type: { name: WORKFLOW_TYPE },
          status: proto.temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING,
          historyLength: events.length,
          startTime: { seconds: 1_700_000_000 },
        },
        pendingActivities: [],
      });
    });
    mock.method(connection.workflowService, 'queryWorkflow', () => {
      const deadline = deadlineOf(connection);
      process.send?.('query-started');
      return new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Query deadline exceeded')), Math.max(0, deadline - Date.now()));
      });
    });
    mock.method(connection.workflowService, 'getWorkflowExecutionHistory', async () => {
      const snapshot = events.slice();
      const deadline = deadlineOf(connection);
      // History 也遵守真实 deadline；只把 Query 改成串行而不预留时间仍会失败。
      await delay(100);
      if (Date.now() >= deadline) throw new Error('History deadline exceeded');
      return { history: { events: snapshot } };
    });
    return connection;
  });
} else {
  async function stopApi(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function startApi(t: TestContext): Promise<{ child: ChildProcess; base: string }> {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--import', fileURLToPath(import.meta.url), 'server/index.ts',
    ], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        API_PORT: '0',
        TEMPORAL_ADDRESS: '127.0.0.1:1',
        TEMPORAL_NAMESPACE: 'order-observation-test',
        TEMPORAL_ORDER_OBSERVATION_FIXTURE: '1',
        PAYMENT_DB_PATH: ':memory:',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => stopApi(child));
    let output = '';
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`API 启动超时：${output}`)), 10_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`API 提前退出（${code}）：${output}`)); });
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    return { child, base };
  }

  test('真实 HTTP：Query 超时期间到达的 Signal 已包含在首个失败 Query 响应的 History 中', { timeout: 25_000 }, async (t) => {
    const { child, base } = await startApi(t);
    const queryStarted = once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    const responsePending = fetch(`${base}/api/orders/${workflowId}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal((await queryStarted)[0], 'query-started');
    const signalRecorded = once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    child.send('record-approval-signal');
    assert.equal((await signalRecorded)[0], 'signal-recorded');

    const response = await responsePending;
    assert.equal(response.status, 200, 'Query 超时后，History 仍应在外层 deadline 内成功返回');
    const detail = await response.json() as OrderDetail;
    assert.equal(detail.workflowId, workflowId);
    assert.equal(detail.runId, runId);
    assert.equal(detail.state, null);
    assert.match(detail.stateError ?? '', /状态 Query 暂不可用/);
    assert.deepEqual(
      detail.history.filter((event) => event.type === 'WorkflowExecutionSignaled')
        .map(({ id, signalName }) => ({ id, signalName })),
      [{ id: '2', signalName: APPROVE_SIGNAL }],
      '第一次 Query 失败响应就必须包含等待期间已入库的 Signal，防止下一次观察误判为新 Signal',
    );
    t.diagnostic(`首个失败 Query 响应已包含 Signal，observedAt=${detail.observedAt}`);
  });
}
