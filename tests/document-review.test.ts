import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { isGrpcCancelledError, isGrpcDeadlineError, WorkflowFailedError, type WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { createDocumentReviewActivities } from '../exercises/01-transfer/01.01-document-review/support/activities';
import { DocumentReviewStore } from '../exercises/01-transfer/01.01-document-review/support/store';
import {
  APPROVE_DOCUMENT_SIGNAL,
  DOCUMENT_REVIEW_STATE_QUERY,
  DOCUMENT_REVIEW_TASK_QUEUE,
  DOCUMENT_REVIEW_WORKFLOW,
  type DocumentActivityArgs,
  type DocumentReviewInput,
  type DocumentReviewState,
} from '../exercises/01-transfer/01.01-document-review/support/types';
import type { documentReviewWorkflow } from '../exercises/01-transfer/01.01-document-review/solution/workflow';

type ReviewHandle = WorkflowHandle<typeof documentReviewWorkflow>;
const exercise = '../exercises/01-transfer/01.01-document-review/';

const RPC_TIMEOUT = 3_000;
// prepare 最多 30 秒；结果预算另容纳最多 30 秒清理，仍保留父级 120 秒兜底。
const STATE_TIMEOUT = 35_000;
const RESULT_TIMEOUT = 65_000;
const lastStates = new WeakMap<ReviewHandle, DocumentReviewState>();

function observation(handle: ReviewHandle, phase: string, expected: string): string {
  const last = lastStates.get(handle);
  return `[${phase}] ${handle.workflowId}；预期：${expected}；最后已观察状态：${last ? JSON.stringify(last) : '未观察到'}`;
}

async function rpc<T>(
  env: TestWorkflowEnvironment,
  handle: ReviewHandle,
  phase: string,
  expected: string,
  operation: () => Promise<T>,
  timeout = RPC_TIMEOUT,
): Promise<T> {
  try {
    return await env.client.connection.withDeadline(Date.now() + timeout, operation);
  } catch (error) {
    throw new Error(`${observation(handle, phase, expected)}；RPC ${isGrpcDeadlineError(error) ? '超时' : '失败'}（${timeout}ms）`, {
      cause: error,
    });
  }
}

async function queryState(
  env: TestWorkflowEnvironment,
  handle: ReviewHandle,
  phase: string,
  expected = '可查询的 documentReviewState',
  timeout = RPC_TIMEOUT,
): Promise<DocumentReviewState> {
  const state = await rpc(env, handle, phase, expected,
    () => handle.query<DocumentReviewState>(DOCUMENT_REVIEW_STATE_QUERY), timeout);
  lastStates.set(handle, state);
  return state;
}

async function waitForState(
  env: TestWorkflowEnvironment,
  handle: ReviewHandle,
  phase: string,
  expected: string,
  predicate: (state: DocumentReviewState) => boolean,
  timeout = STATE_TIMEOUT,
): Promise<DocumentReviewState> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await queryState(env, handle, phase, expected, Math.min(RPC_TIMEOUT, deadline - Date.now()));
    if (predicate(state)) return state;
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${observation(handle, phase, expected)}；等待状态超时（${timeout}ms）`);
}

async function waitForResult(
  env: TestWorkflowEnvironment,
  handle: ReviewHandle,
  phase: string,
  expected = 'completed',
  timeout = RESULT_TIMEOUT,
): Promise<DocumentReviewState> {
  try {
    const result = await env.client.connection.withDeadline(Date.now() + timeout, () => handle.result());
    lastStates.set(handle, result);
    return result;
  } catch (error) {
    let diagnostic = '';
    if (isGrpcDeadlineError(error)) {
      try {
        await queryState(env, handle, `${phase} / 超时诊断`, '最后业务状态', 500);
      } catch (queryError) {
        diagnostic = `；限时诊断 Query：${String(queryError)}`;
      }
    }
    if (error instanceof WorkflowFailedError) {
      throw new WorkflowFailedError(`${observation(handle, phase, expected)}；${error.message}`, error.cause, error.retryState);
    }
    throw new Error(`${observation(handle, phase, expected)}；等待结果${isGrpcDeadlineError(error) ? '超时' : '失败'}（${timeout}ms）${diagnostic}`, {
      cause: error,
    });
  }
}

async function expectFailure(
  env: TestWorkflowEnvironment,
  handle: ReviewHandle,
  phase: string,
  type: string,
  timeout = RESULT_TIMEOUT,
): Promise<void> {
  const expected = `失败类型 ${type}`;
  await assert.rejects(waitForResult(env, handle, phase, expected, timeout), (error: unknown) => {
    // 保留阶段超时及真正的 gRPC cause，不把它误报成业务失败类型不匹配。
    if (!(error instanceof WorkflowFailedError)) throw error;
    const message = observation(handle, phase, expected);
    if (type === 'cancelled') assert.ok(error.cause instanceof CancelledFailure, message);
    else {
      assert.ok(error.cause instanceof ApplicationFailure, message);
      assert.equal(error.cause.type, type, message);
      assert.equal(error.cause.nonRetryable, true, message);
    }
    return true;
  }, observation(handle, phase, expected));
}

async function waitForGate(handle: ReviewHandle, phase: string, gate: ReturnType<typeof deferred>): Promise<void> {
  const timer = new AbortController();
  try {
    await Promise.race([
      gate.promise,
      delay(STATE_TIMEOUT, undefined, { signal: timer.signal, ref: false }).then(() => {
        throw new Error(`${observation(handle, phase, '活动进入门控')}；等待活动门控超时（${STATE_TIMEOUT}ms）`);
      }),
    ]);
  } finally { timer.abort(); }
}

async function approveAndWaitForTask(env: TestWorkflowEnvironment, handle: ReviewHandle, phase: string): Promise<void> {
  const expected = '本次 approveDocument 后的 WorkflowTaskCompleted';
  const before = await rpc(env, handle, phase, 'Signal 前 History 边界', () => handle.fetchHistory());
  const boundary = BigInt(String(before.events?.at(-1)?.eventId ?? 0));
  await rpc(env, handle, phase, expected, () => handle.signal(APPROVE_DOCUMENT_SIGNAL));
  const deadline = Date.now() + 15_000;
  let lastEventId = boundary;
  let signalId: bigint | undefined;
  while (Date.now() < deadline) {
    const history = await rpc(env, handle, phase, expected, () => handle.fetchHistory(),
      Math.min(RPC_TIMEOUT, deadline - Date.now()));
    const events = history.events ?? [];
    lastEventId = BigInt(String(events.at(-1)?.eventId ?? 0));
    const signal = events.find((event) => BigInt(String(event.eventId)) > boundary
      && event.workflowExecutionSignaledEventAttributes?.signalName === APPROVE_DOCUMENT_SIGNAL);
    if (signal) {
      const currentSignalId = BigInt(String(signal.eventId));
      signalId = currentSignalId;
      // Started 也必须在本次 Signal 之后，避免误认上一轮尚在完成的 Workflow Task。
      if (events.some((event) => event.workflowTaskCompletedEventAttributes
        && BigInt(String(event.workflowTaskCompletedEventAttributes.startedEventId)) > currentSignalId)) return;
    }
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${observation(handle, phase, expected)}；等待 Signal 处理超时；Signal eventId=${signalId ?? '未观察到'}，最后 History eventId=${lastEventId}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function activityGate() {
  const entered = deferred();
  let released = false;
  return {
    entered,
    release: () => { released = true; },
    async wait() {
      entered.resolve();
      while (!released) {
        Context.current().heartbeat();
        await Context.current().sleep(50);
      }
    },
  };
}

test('资料审核：真实编排、SQLite 幂等、清理与同 Run Worker 恢复', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-document-review-test-'));
  const store = new DocumentReviewStore(join(directory, 'documents.db'));
  let environment: TestWorkflowEnvironment | undefined;
  try {
    // 不复用开发服务、默认 namespace 或用户账本，也不读取 TEMPORAL_TEST_ADDRESS。
    environment = await TestWorkflowEnvironment.createLocal({ server: { namespace: 'document-review-test' } });
    const env = environment;
    assert.equal(env.namespace, 'document-review-test');
    const taskQueue = `document-review-test-${randomUUID()}`;
    const variant = process.env.DOCUMENT_REVIEW_TEST_VARIANT || 'solution';
    assert.ok(variant === 'problem' || variant === 'solution', 'DOCUMENT_REVIEW_TEST_VARIANT 只支持 problem / solution');
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL(`${exercise}${variant}/workflow.ts`, import.meta.url)),
    });
    const activities = createDocumentReviewActivities(store);
    const heldPrepareResults = new Map<string, ReturnType<typeof activityGate>>();
    const prepareGates = new Map<string, ReturnType<typeof activityGate>>();
    const archiveGates = new Map<string, ReturnType<typeof activityGate>>();
    const failArchive = new Set<string>();
    const failCleanup = new Set<string>();
    const createWorker = () => Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowBundle,
      activities: {
        ...activities,
        async prepareDocument(args: DocumentActivityArgs) {
          await prepareGates.get(args.workflowId)?.wait();
          const result = await activities.prepareDocument(args);
          // 真实准备及首次丢响应之后，重试也已查账，但故意延迟成功响应至取消。
          await heldPrepareResults.get(args.workflowId)?.wait();
          return result;
        },
        async archiveDocument(args: DocumentActivityArgs) {
          await archiveGates.get(args.workflowId)?.wait();
          await activities.archiveDocument(args);
          if (failArchive.has(args.workflowId)) {
            throw ApplicationFailure.nonRetryable('测试：归档已提交但未返回', 'ArchiveResponseLost');
          }
        },
        async cleanupDocument(args: DocumentActivityArgs) {
          if (failCleanup.has(args.workflowId)) {
            throw ApplicationFailure.nonRetryable('测试：清理存储不可用', 'CleanupUnavailable');
          }
          return activities.cleanupDocument(args);
        },
      },
      shutdownGraceTime: '2 seconds',
      maxHeartbeatThrottleInterval: '100ms',
    });
    const start = async (overrides: Partial<DocumentReviewInput> = {}, workflowId = `document-review-test-${randomUUID()}`) => {
      const started = await env.client.workflow.start<typeof documentReviewWorkflow>(DOCUMENT_REVIEW_WORKFLOW, {
        workflowId,
        taskQueue,
        args: [{ documentId: 'test-document', reviewTimeoutSeconds: 60, ...overrides }],
      });
      return env.client.workflow.getHandle<typeof documentReviewWorkflow>(workflowId, started.firstExecutionRunId, {
        followRuns: false,
      });
    };
    const approve = (handle: ReviewHandle) => handle.signal(APPROVE_DOCUMENT_SIGNAL);

    await t.test('无 Worker：Query 和结果等待按阶段截止，诊断 Query 也有期限', { timeout: 10_000 }, async (context) => {
      const started = await env.client.workflow.start<typeof documentReviewWorkflow>(DOCUMENT_REVIEW_WORKFLOW, {
        workflowId: `document-review-deadline-${randomUUID()}`,
        taskQueue: `document-review-no-worker-${randomUUID()}`,
        args: [{ documentId: 'deadline-document', reviewTimeoutSeconds: 60 }],
      });
      const handle = env.client.workflow.getHandle<typeof documentReviewWorkflow>(started.workflowId, started.firstExecutionRunId, {
        followRuns: false,
      });
      const checkTimeout = (phase: string, expected: string, allowCancelled = false) => (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`${context.name}.*${phase}`));
        assert.ok(error.message.includes(expected));
        assert.match(error.message, /最后已观察状态：未观察到/);
        const deadlineExceeded = isGrpcDeadlineError(error);
        // 无消费者 Query 在截止边界也可能收到 CANCELLED，保留实际错误分类。
        assert.ok(deadlineExceeded || (allowCancelled && isGrpcCancelledError(error)),
          `必须是 SDK 已结束的截止或取消错误：${String(error.cause)}`);
        assert.match(error.message, deadlineExceeded ? /超时/ : /RPC 失败/);
        if (!allowCancelled) assert.match(error.message, /限时诊断 Query/);
        return true;
      };
      const began = Date.now();
      try {
        await assert.rejects(
          waitForState(env, handle, `${context.name} / 无消费者 Query`, 'waiting_review',
            (state) => state.status === 'waiting_review', 250),
          checkTimeout('无消费者 Query', 'waiting_review', true),
        );
        assert.ok(Date.now() - began >= 200, '无消费者 Query 应等到接近 250ms 截止，不能提前失败');
        await assert.rejects(
          waitForResult(env, handle, `${context.name} / 无消费者结果`, 'completed', 250),
          checkTimeout('无消费者结果', 'completed'),
        );
        await assert.rejects(
          expectFailure(env, handle, `${context.name} / 无消费者失败`, 'DocumentReviewTimedOut', 250),
          checkTimeout('无消费者失败', 'DocumentReviewTimedOut'),
        );
        assert.ok(Date.now() - began < 5_000, '阶段等待及诊断应先于父级兜底结束');
      } finally {
        await env.client.connection.withDeadline(Date.now() + 3_000, () => handle.terminate('期限回归完成'));
      }
      assert.equal((await handle.describe()).status.name, 'TERMINATED');
      assert.equal(store.get(handle.workflowId).prepared, 0);
    });

    const worker = await createWorker();
    await worker.runUntil(async () => {
      await t.test('正常完成：准备、等待、Signal、归档；Query 契约与 History 一致', async (context) => {
        const handle = await start();
        const waiting = await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
        assert.equal(waiting.prepareCompleted, true);
        assert.ok(waiting.reviewDeadline);
        assert.equal(waiting.approvedAt, undefined);
        await approve(handle);
        const result = await waitForResult(env, handle, `${context.name} / 等待归档完成`);
        assert.equal(result.status, 'completed');
        assert.equal(result.cleanup.status, 'idle');
        assert.ok(result.approvedAt);
        assert.equal((await handle.describe()).status.name, 'COMPLETED');
        assert.equal(store.get(handle.workflowId).prepared, 1);
        assert.equal(store.get(handle.workflowId).archived, 1);
        assert.equal(store.get(handle.workflowId).removed, 0);
        const history = await handle.fetchHistory();
        const scheduled = (history.events ?? []).filter((event) => event.activityTaskScheduledEventAttributes);
        assert.deepEqual(scheduled.map((event) => event.activityTaskScheduledEventAttributes?.activityType?.name), [
          'prepareDocument', 'archiveDocument',
        ]);
        assert.ok((history.events ?? []).some((event) =>
          event.workflowExecutionSignaledEventAttributes?.signalName === APPROVE_DOCUMENT_SIGNAL));
      });

      await t.test('提前确认与归档中重复确认：处理过的 Signal 不改变首次有效确认，仅归档一次', async (context) => {
        const workflowId = `document-review-signal-boundaries-${randomUUID()}`;
        const prepareGate = activityGate();
        const archiveGate = activityGate();
        prepareGates.set(workflowId, prepareGate);
        archiveGates.set(workflowId, archiveGate);
        try {
          const handle = await start({}, workflowId);
          await waitForGate(handle, `${context.name} / prepare 进入门控`, prepareGate.entered);
          const preparing = await queryState(env, handle, `${context.name} / 提前确认前`, 'preparing');
          assert.equal(preparing.status, 'preparing');
          assert.equal(preparing.prepareCompleted, false);
          assert.equal(preparing.approvedAt, undefined);

          await approveAndWaitForTask(env, handle, `${context.name} / preparing 提前确认已处理`);
          const early = await queryState(env, handle, `${context.name} / 提前确认处理后`, 'preparing 且无 approvedAt');
          assert.equal(early.status, 'preparing');
          assert.equal(early.approvedAt, undefined);
          assert.equal(store.get(workflowId).archived, 0);

          prepareGate.release();
          const waiting = await waitForState(env, handle, `${context.name} / 释放 prepare`, 'waiting_review 且未提前确认',
            (state) => state.status === 'waiting_review');
          assert.equal(waiting.prepareCompleted, true);
          assert.equal(waiting.approvedAt, undefined);
          assert.equal(store.get(workflowId).archived, 0);
          const waitingHistory = await rpc(env, handle, `${context.name} / 提前确认未触发归档`, '无 archiveDocument 调度',
            () => handle.fetchHistory());
          assert.ok(!(waitingHistory.events ?? []).some((event) =>
            event.activityTaskScheduledEventAttributes?.activityType?.name === 'archiveDocument'));

          await approveAndWaitForTask(env, handle, `${context.name} / 首次有效确认已处理`);
          await waitForGate(handle, `${context.name} / archive 进入门控`, archiveGate.entered);
          const archiving = await queryState(env, handle, `${context.name} / 首次有效确认后`, 'archiving 且 approvedAt 有值');
          assert.equal(archiving.status, 'archiving');
          assert.ok(archiving.approvedAt);

          await approveAndWaitForTask(env, handle, `${context.name} / archiving 重复确认已处理`);
          const duplicate = await queryState(env, handle, `${context.name} / 重复确认处理后`, 'archiving 且保留首次 approvedAt');
          assert.equal(duplicate.status, 'archiving');
          assert.equal(duplicate.approvedAt, archiving.approvedAt);
          assert.equal(store.get(workflowId).archived, 0);

          archiveGate.release();
          const result = await waitForResult(env, handle, `${context.name} / 释放 archive 后完成`);
          assert.equal(result.status, 'completed');
          assert.equal(result.approvedAt, archiving.approvedAt);
          const ledger = store.get(workflowId);
          assert.equal(ledger.archived, 1);
          assert.equal(ledger.entries.filter((entry) => entry.kind === 'archive_attempt').length, 1);
          const history = await rpc(env, handle, `${context.name} / 最终 History`, '一次 archiveDocument 调度',
            () => handle.fetchHistory());
          assert.equal((history.events ?? []).filter((event) =>
            event.activityTaskScheduledEventAttributes?.activityType?.name === 'archiveDocument').length, 1);
          assert.equal((history.events ?? []).filter((event) =>
            event.workflowExecutionSignaledEventAttributes?.signalName === APPROVE_DOCUMENT_SIGNAL).length, 3);
        } finally {
          prepareGate.release();
          archiveGate.release();
          prepareGates.delete(workflowId);
          archiveGates.delete(workflowId);
        }
      });

      await t.test('首次准备事务后响应丢失：实际尝试 2 次，prepared 仍为 1', async (context) => {
        const handle = await start({ losePrepareResponse: true });
        await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
        await approve(handle);
        await waitForResult(env, handle, `${context.name} / 等待归档完成`);
        const ledger = store.get(handle.workflowId);
        assert.equal(ledger.prepareAttempts, 2);
        assert.equal(ledger.prepared, 1);
        assert.equal(ledger.reused, 1);
        assert.equal(ledger.archived, 1);
        assert.equal(ledger.idempotencyKey, `${handle.workflowId}:prepare`);
        assert.equal(ledger.entries.filter((entry) => entry.kind === 'response_lost').length, 1);
        assert.deepEqual(ledger.entries.filter((entry) => entry.kind === 'prepare_attempt').map((entry) => entry.attempt), [1, 2]);
        const { runId } = await handle.describe();
        assert.ok(ledger.entries.every((entry) => entry.runId === runId));
      });

      await t.test('持久化审核 Timer 超时：清理后以 nonretryable failure 结束', async (context) => {
        const handle = await start({ reviewTimeoutSeconds: 1 });
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'DocumentReviewTimedOut');
        const state = await queryState(env, handle, `${context.name} / 检查业务状态`);
        assert.equal(state.status, 'timed_out');
        assert.deepEqual(state.cleanup, { status: 'completed', outcome: 'removed' });
        assert.equal((await handle.describe()).status.name, 'FAILED');
        assert.equal(store.get(handle.workflowId).removed, 1);
        assert.equal(store.get(handle.workflowId).document?.content, null);
        assert.equal(store.get(handle.workflowId).archived, 0);
      });

      await t.test('等待审核时协作取消：先清理再进入 Temporal CANCELLED', async (context) => {
        const handle = await start();
        await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
        await handle.cancel();
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'cancelled');
        assert.equal((await handle.describe()).status.name, 'CANCELLED');
        const state = await queryState(env, handle, `${context.name} / 检查业务状态`);
        assert.equal(state.status, 'cancelled');
        assert.equal(state.cleanup.status, 'completed');
        assert.equal(store.get(handle.workflowId).removed, 1);
        const ledger = store.get(handle.workflowId);
        // 直接重复清理验证业务幂等：removed 数量不增加，墓碑阻止再创建。
        assert.equal(store.cleanup({ workflowId: handle.workflowId, documentId: 'test-document' }, {
          runId: state.runId, activityId: 'manual-cleanup-check', attempt: 2,
        }).outcome, 'already_removed');
        assert.equal(store.get(handle.workflowId).removed, ledger.removed);
        assert.throws(() => store.prepare({ workflowId: handle.workflowId, documentId: 'test-document' }, {
          runId: state.runId, activityId: 'manual-prepare-check', attempt: 3,
        }), /已清理资料/);
      });

      await t.test('准备结果未知后取消：prepareCompleted=false 仍查账删除已提交内容', async (context) => {
        const workflowId = `document-review-unknown-${randomUUID()}`;
        const held = activityGate();
        heldPrepareResults.set(workflowId, held);
        try {
          const handle = await start({ losePrepareResponse: true }, workflowId);
          await waitForGate(handle, `${context.name} / 等待第二次准备响应`, held.entered);
          const state = await queryState(env, handle, `${context.name} / 检查业务状态`);
          assert.equal(state.prepareAttempted, true);
          assert.equal(state.prepareCompleted, false);
          assert.equal(store.get(workflowId).prepared, 1);
          await handle.cancel();
          await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'cancelled');
          const after = await queryState(env, handle, `${context.name} / 检查业务状态`);
          assert.equal(after.prepareCompleted, false);
          assert.equal(after.cleanup.outcome, 'removed');
          assert.equal(store.get(workflowId).prepareAttempts, 2);
          assert.equal(store.get(workflowId).removed, 1);
          assert.equal(store.get(workflowId).document?.content, null);
        } finally {
          held.release();
          heldPrepareResults.delete(workflowId);
        }
      });

      await t.test('归档写入后的失败仍清理已尝试的资料', async (context) => {
        const workflowId = `document-review-archive-failure-${randomUUID()}`;
        failArchive.add(workflowId);
        const handle = await start({}, workflowId);
        await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
        await approve(handle);
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'DocumentReviewFailed');
        assert.equal(store.get(workflowId).archived, 1);
        assert.equal(store.get(workflowId).removed, 1);
        assert.equal((await queryState(env, handle, `${context.name} / 检查业务状态`)).cleanup.status, 'completed');
      });

      await t.test('清理失败不能伪装成已取消/已清理', async (context) => {
        const workflowId = `document-review-cleanup-failure-${randomUUID()}`;
        failCleanup.add(workflowId);
        const handle = await start({}, workflowId);
        await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
        await handle.cancel();
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'DocumentCleanupFailed');
        const state = await queryState(env, handle, `${context.name} / 检查业务状态`);
        assert.equal(state.cleanup.status, 'failed');
        assert.equal(state.status, 'failed');
        assert.equal((await handle.describe()).status.name, 'FAILED');
        assert.equal(store.get(workflowId).removed, 0);
      });

      await t.test('绕过 CLI 的非法输入也明确失败且不产生资料', async (context) => {
        const handle = await start({ reviewTimeoutSeconds: 0 });
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'InvalidDocumentReviewInput');
        assert.equal(store.get(handle.workflowId).prepared, 0);
      });
    });

    await t.test('两个 Worker 先后消费：停机 Signal 入库，重启同 Run 且准备不重复', async (context) => {
      const firstWorker = await createWorker();
      let handle!: ReviewHandle;
      let baseline!: Awaited<ReturnType<DocumentReviewStore['get']>>;
      let completedPrepareEventId = '';
      let runId = '';
      // runUntil 在回调完成后优雅关闭 firstWorker；此时停在持久化等待点。
      await firstWorker.runUntil(async () => {
        handle = await start({ reviewTimeoutSeconds: 120 });
        const waiting = await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
        runId = waiting.runId;
        baseline = store.get(handle.workflowId);
        assert.equal(baseline.prepareAttempts, 1);
        const history = await handle.fetchHistory();
        const prepared = (history.events ?? []).find((event) => event.activityTaskCompletedEventAttributes);
        assert.ok(prepared);
        completedPrepareEventId = String(prepared.eventId);
      });
      assert.equal((await handle.describe()).runId, runId);
      assert.equal((await handle.describe()).status.name, 'RUNNING');
      await assert.rejects(queryState(env, handle, `${context.name} / Worker 停机 Query`, '无 Worker 时 Query 不可用', 500));
      const stoppedHistory = await handle.fetchHistory();
      const boundary = BigInt(String(stoppedHistory.events?.at(-1)?.eventId ?? 0));
      assert.ok(!(stoppedHistory.events ?? []).some((event) => event.workflowExecutionSignaledEventAttributes));
      // Server 接受 Signal；此时没有任何该 task queue 的 Worker。
      await approve(handle);
      const signaledHistory = await handle.fetchHistory();
      const signal = (signaledHistory.events ?? []).find((event) =>
        event.workflowExecutionSignaledEventAttributes?.signalName === APPROVE_DOCUMENT_SIGNAL);
      assert.ok(signal);
      assert.ok(BigInt(String(signal.eventId)) > boundary);
      assert.equal((await handle.describe()).status.name, 'RUNNING');
      assert.equal(store.get(handle.workflowId).archived, 0);
      assert.equal(store.get(handle.workflowId).prepareAttempts, baseline.prepareAttempts);

      const secondWorker = await createWorker();
      await secondWorker.runUntil(async () => {
        const result = await waitForResult(env, handle, `${context.name} / 等待归档完成`);
        assert.equal(result.runId, runId);
        assert.equal(result.status, 'completed');
        const description = await handle.describe();
        assert.equal(description.runId, runId);
        assert.equal(description.status.name, 'COMPLETED');
        const after = store.get(handle.workflowId);
        assert.equal(after.prepareAttempts, baseline.prepareAttempts);
        assert.equal(after.prepared, baseline.prepared);
        assert.equal(after.archived, 1);
        const events = (await handle.fetchHistory()).events ?? [];
        assert.ok(events.some((event) => String(event.eventId) === completedPrepareEventId));
        assert.equal(events.filter((event) =>
          event.activityTaskScheduledEventAttributes?.activityType?.name === 'prepareDocument').length, 1);
        assert.ok(events.some((event) => event.workflowTaskCompletedEventAttributes
          && BigInt(String(event.eventId)) > BigInt(String(signal.eventId))));
      });
    });

    await t.test('CLI 独立进程：start 输出完整 ID，停机 inspect 仍读 History/账本，approve 直接 Signal', async (context) => {
      const cli = fileURLToPath(new URL(`${exercise}solution/main.ts`, import.meta.url));
      const runCli = async (...args: string[]) => {
        const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, ...args], {
          env: {
            ...process.env,
            TEMPORAL_ADDRESS: env.address,
            TEMPORAL_NAMESPACE: env.namespace,
            DOCUMENT_REVIEW_DB_PATH: join(directory, 'documents.db'),
          },
          timeout: 20_000,
          maxBuffer: 2_000_000,
        });
        return stdout;
      };
      const started = JSON.parse(await runCli('start', '--document', 'cli-document', '--timeout', '120')) as {
        workflowId: string; runId: string; namespace: string; taskQueue: string;
      };
      assert.ok(started.workflowId.startsWith('document-review-solution-'));
      assert.match(started.runId, /^[a-f\d-]{36}$/);
      assert.equal(started.namespace, env.namespace);
      assert.equal(started.taskQueue, DOCUMENT_REVIEW_TASK_QUEUE);
      const handle = env.client.workflow.getHandle<typeof documentReviewWorkflow>(started.workflowId, started.runId, {
        followRuns: false,
      });
      // 仅测试临时服务的练习队列，不触碰开发队列或默认账本。
      const cliWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace,
        taskQueue: DOCUMENT_REVIEW_TASK_QUEUE,
        workflowBundle,
        activities,
      });
      await cliWorker.runUntil(async () => {
        await waitForState(env, handle, `${context.name} / 等待准备完成`, 'waiting_review',
          (state) => state.status === 'waiting_review');
      });
      const stopped = JSON.parse(await runCli('inspect', started.workflowId, started.runId));
      assert.equal(stopped.description.value.runId, started.runId);
      assert.equal(stopped.description.value.status, 'RUNNING');
      assert.equal(stopped.query.ok, false);
      assert.equal(stopped.history.ok, true);
      assert.equal(stopped.ledger.ok, true);
      assert.equal(stopped.ledger.value.prepared, 1);
      const completedPrepare = stopped.history.value.events.find((event: { type: string }) =>
        event.type === 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED');
      assert.equal(completedPrepare.activityType, 'prepareDocument');
      assert.ok(completedPrepare.eventId);
      assert.ok(completedPrepare.scheduledEventId);
      const boundary = BigInt(stopped.history.value.lastEventId);
      assert.match(await runCli('approve', started.workflowId, started.runId), /Signal 已提交/);
      const signaled = JSON.parse(await runCli('inspect', started.workflowId, started.runId));
      assert.equal(signaled.query.ok, false);
      assert.ok(signaled.history.value.events.some((event: { signalName?: string; eventId: string }) =>
        event.signalName === APPROVE_DOCUMENT_SIGNAL && BigInt(event.eventId) > boundary));
      assert.match(await runCli('cancel', started.workflowId, started.runId), /取消请求已提交/);
      const cleanupWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace,
        taskQueue: DOCUMENT_REVIEW_TASK_QUEUE,
        workflowBundle,
        activities,
      });
      await cleanupWorker.runUntil(async () => {
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'cancelled');
        assert.equal(store.get(started.workflowId).removed, 1);
        await assert.rejects(runCli('result', started.workflowId, started.runId), (error: unknown) => {
          assert.ok(error instanceof Error && 'stderr' in error);
          assert.match(String(error.stderr), /CancelledFailure/);
          return true;
        });
      });
    });

    await t.test('题目占位实现明确失败，不返回伪造完成', { skip: variant === 'problem' }, async (context) => {
      const problemTaskQueue = `document-review-problem-test-${randomUUID()}`;
      const problemWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace,
        taskQueue: problemTaskQueue,
        workflowsPath: fileURLToPath(new URL(`${exercise}problem/workflow.ts`, import.meta.url)),
        activities,
      });
      await problemWorker.runUntil(async () => {
        const handle = await env.client.workflow.start<typeof documentReviewWorkflow>(DOCUMENT_REVIEW_WORKFLOW, {
          workflowId: `document-review-problem-${randomUUID()}`,
          taskQueue: problemTaskQueue,
          args: [{ documentId: 'unimplemented', reviewTimeoutSeconds: 10 }],
        });
        await expectFailure(env, handle, `${context.name} / 等待失败或取消并完成清理`, 'DocumentReviewNotImplemented');
        assert.equal((await queryState(env, handle, `${context.name} / 检查业务状态`)).status, 'not_implemented');
        assert.equal(store.get(handle.workflowId).prepared, 0);
      });
    });
  } finally {
    try { await environment?.teardown(); } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
