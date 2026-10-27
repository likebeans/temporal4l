import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure, decodeTimeoutType } from '@temporalio/common';
import { WorkflowFailedError, type WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { OrderActivityArgs } from '../server/activities';
import { closePaymentStore, getPaymentStore } from '../server/payment-ledger';
import { presentPendingActivities } from '../server/pending-activities';
import { orderWorkflow } from '../server/workflows';
import {
  APPROVE_SIGNAL,
  STATE_QUERY,
  type OrderInput,
  type OrderState,
  type PackingCheckpoint,
} from '../shared/types';

const workflowsPath = fileURLToPath(new URL('../server/workflows.ts', import.meta.url));

function orderInput(scenario: OrderInput['scenario']): OrderInput {
  return {
    customerName: 'Temporal 实验测试',
    productId: 'keyboard',
    quantity: 1,
    scenario,
    approvalTimeoutSeconds: 90,
  };
}

async function waitForState(
  handle: WorkflowHandle<typeof orderWorkflow>,
  description: string,
  predicate: (state: OrderState) => boolean,
  timeoutMs = 30_000,
): Promise<OrderState> {
  const deadline = Date.now() + timeoutMs;
  let lastState: OrderState | undefined;
  while (Date.now() < deadline) {
    try {
      lastState = await handle.query<OrderState>(STATE_QUERY);
      if (predicate(lastState)) return lastState;
    } catch {
      // Query handler is unavailable before the first Workflow Task completes.
    }
    await delay(100);
  }
  assert.fail(`等待${description}超时，最后状态：${JSON.stringify(lastState)}`);
}

async function waitForPackingHeartbeat(
  handle: WorkflowHandle<typeof orderWorkflow>,
  predicate: (heartbeat: PackingCheckpoint) => boolean = (heartbeat) => heartbeat.completedBatches >= 1,
): Promise<PackingCheckpoint> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const description = await handle.describe();
    const heartbeat = presentPendingActivities(description.raw.pendingActivities ?? [])
      .find((activity) => activity.activityType === 'packOrder')?.heartbeat;
    if (heartbeat && predicate(heartbeat)) return heartbeat;
    await delay(100);
  }
  assert.fail('等待 packOrder heartbeat 超时');
}

function heartbeatTimeoutCount(history: Awaited<ReturnType<WorkflowHandle['fetchHistory']>>): number {
  return (history.events ?? []).filter((event) => {
    // Retried Activity timeouts are compacted into the next ActivityTaskStarted event.
    const failure = event.activityTaskStartedEventAttributes?.lastFailure;
    return decodeTimeoutType(failure?.timeoutFailureInfo?.timeoutType) === 'HEARTBEAT';
  }).length;
}

test('真实 Activity 验证幂等、心跳恢复与打包取消', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-activity-experiments-'));
  const previousPaymentPath = process.env.PAYMENT_DB_PATH;
  process.env.PAYMENT_DB_PATH = join(directory, 'payments.db');

  const environment = process.env.TEMPORAL_TEST_ADDRESS
    ? await TestWorkflowEnvironment.createFromExistingServer({
        address: process.env.TEMPORAL_TEST_ADDRESS,
        namespace: process.env.TEMPORAL_TEST_NAMESPACE || 'default',
      })
    : await TestWorkflowEnvironment.createLocal();
  const taskQueue = `activity-experiments-${randomUUID()}`;
  // Activities stay outside the workflow sandbox and use this suite's isolated payment database.
  const activities = await import('../server/activities');
  const lostPaymentResponses = new Map<string, { retryStarted?: () => void }>();

  try {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath,
      activities: {
        ...activities,
        async chargePayment(args: OrderActivityArgs) {
          const controlled = lostPaymentResponses.get(args.workflowId);
          if (!controlled) return activities.chargePayment(args);
          const context = Context.current();
          const payments = getPaymentStore();
          payments.recordAttempt(args.workflowId, context.info.attempt);
          payments.charge(args.workflowId, args.total, context.info.attempt);
          if (context.info.attempt > 1 && controlled.retryStarted) {
            controlled.retryStarted();
            while (true) {
              context.heartbeat();
              await context.sleep(100);
            }
          }
          payments.recordFailure(args.workflowId, context.info.attempt, '测试扣款已提交，但支付响应丢失');
          throw ApplicationFailure.retryable('测试扣款成功后响应丢失', 'PaymentResponseLost');
        },
      },
      maxHeartbeatThrottleInterval: '500ms',
    });

    await worker.runUntil(async () => {
      const start = (
        scenario: OrderInput['scenario'],
        workflowId = `experiment-${scenario}-${randomUUID()}`,
      ) => environment.client.workflow.start(orderWorkflow, {
        taskQueue,
        workflowId,
        args: [orderInput(scenario)],
      });

      await t.test('普通场景扣款提交后响应丢失，取消仍会退款', async () => {
        const workflowId = `experiment-payment-cancel-${randomUUID()}`;
        let retryStarted!: () => void;
        const retryStartedPromise = new Promise<void>((resolve) => { retryStarted = resolve; });
        lostPaymentResponses.set(workflowId, { retryStarted });
        const handle = await start('normal', workflowId);
        try {
          await Promise.race([
            retryStartedPromise,
            delay(15_000, undefined, { ref: false }).then(() => assert.fail('等待已扣款后的支付重试超时')),
          ]);
          const charging = await handle.query<OrderState>(STATE_QUERY);
          assert.equal(charging.steps.find((step) => step.id === 'payment')?.status, 'running');
          assert.equal(getPaymentStore().get(workflowId).debitCount, 1);

          await handle.cancel();
          await assert.rejects(
            handle.result(),
            (error: unknown) => error instanceof WorkflowFailedError && error.cause instanceof CancelledFailure,
          );
          const state = await handle.query<OrderState>(STATE_QUERY);
          const ledger = getPaymentStore().get(workflowId);

          assert.equal((await handle.describe()).status.name, 'CANCELLED');
          assert.equal(state.status, 'cancelled');
          assert.equal(ledger.debitCount, 1);
          assert.equal(ledger.refundCount, 1);
          assert.equal(ledger.totalCharged - ledger.totalRefunded, 0);
          assert.equal(state.compensationProgress?.status, 'completed');
          assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
        } finally {
          lostPaymentResponses.delete(workflowId);
          if ((await handle.describe()).status.name === 'RUNNING') await handle.cancel();
        }
      });

      await t.test('普通场景扣款提交后响应持续丢失，最终失败仍会退款', async () => {
        const workflowId = `experiment-payment-failure-${randomUUID()}`;
        lostPaymentResponses.set(workflowId, {});
        const handle = await start('normal', workflowId);
        try {
          await assert.rejects(
            handle.result(),
            (error: unknown) => error instanceof WorkflowFailedError
              && error.cause instanceof ApplicationFailure
              && error.cause.type === 'OrderWorkflowFailed',
          );
          const state = await handle.query<OrderState>(STATE_QUERY);
          const ledger = getPaymentStore().get(workflowId);

          assert.equal((await handle.describe()).status.name, 'FAILED');
          assert.equal(state.status, 'failed');
          assert.equal(ledger.attempts, 3);
          assert.equal(ledger.debitCount, 1);
          assert.equal(ledger.refundCount, 1);
          assert.equal(ledger.totalCharged - ledger.totalRefunded, 0);
          assert.equal(state.compensationProgress?.status, 'completed');
          assert.equal(state.steps.find((step) => step.id === 'payment')?.status, 'failed');
          assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
        } finally {
          lostPaymentResponses.delete(workflowId);
          if ((await handle.describe()).status.name === 'RUNNING') await handle.cancel();
        }
      });

      await t.test('响应丢失重试只产生一次实际扣款', async () => {
        const handle = await start('idempotency');
        try {
          const waiting = await waitForState(
            handle,
            '幂等付款完成',
            (state) => state.status === 'waiting_approval',
          );
          const ledger = getPaymentStore().get(handle.workflowId);

          assert.equal(ledger.attempts, 2);
          assert.equal(ledger.debitCount, 1);
          assert.equal(ledger.totalCharged, 299);
          assert.deepEqual(
            ledger.entries.map((entry) => entry.kind),
            ['attempt', 'debit', 'failure', 'attempt', 'reused'],
          );
          assert.match(waiting.steps.find((step) => step.id === 'payment')?.detail ?? '', /第 2 次尝试/);

          await handle.signal(APPROVE_SIGNAL);
          assert.equal((await handle.result()).status, 'completed');
        } finally {
          if ((await handle.describe()).status.name === 'RUNNING') await handle.cancel();
        }
      });

      await t.test('心跳超时后从服务端检查点继续并完成', async () => {
        const handle = await start('heartbeat_timeout');
        try {
          await waitForState(handle, '等待人工确认', (state) => state.status === 'waiting_approval');
          await handle.signal(APPROVE_SIGNAL);
          const result = await handle.result();
          const history = await handle.fetchHistory();

          assert.equal(result.status, 'completed');
          assert.deepEqual(result.steps.map((step) => step.id), [
            'inventory', 'payment', 'approval', 'packing', 'shipping',
          ]);
          assert.equal(result.packing?.completedBatches, 12);
          assert.equal(result.packing?.totalBatches, 12);
          assert.equal(result.packing?.phase, 'completed');
          assert.equal(result.packing?.attempt, 2);
          assert.equal(result.packing?.resumedFrom, 3);
          assert.equal(heartbeatTimeoutCount(history), 1);
        } finally {
          if ((await handle.describe()).status.name === 'RUNNING') await handle.cancel();
        }
      });

      await t.test('心跳暂停期间取消保持 CANCELLED，补偿后不会发货', async () => {
        const handle = await start('heartbeat_timeout');
        try {
          await waitForState(handle, '等待人工确认', (state) => state.status === 'waiting_approval');
          await handle.signal(APPROVE_SIGNAL);
          const heartbeat = await waitForPackingHeartbeat(
            handle,
            (checkpoint) => checkpoint.phase === 'paused',
          );
          assert.equal(heartbeat.completedBatches, 3);
          assert.equal(heartbeat.attempt, 1);

          await handle.cancel();
          await assert.rejects(
            handle.result(),
            (error: unknown) => error instanceof WorkflowFailedError && error.cause instanceof CancelledFailure,
          );
          const state = await handle.query<OrderState>(STATE_QUERY);
          const ledger = getPaymentStore().get(handle.workflowId);
          const history = await handle.fetchHistory();
          const scheduledActivityNames = new Map(
            (history.events ?? []).flatMap((event) => event.activityTaskScheduledEventAttributes
              ? [[event.eventId?.toString(), event.activityTaskScheduledEventAttributes.activityType?.name] as const]
              : []),
          );
          const completedActivityNames = (history.events ?? []).flatMap((event) => {
            const scheduledId = event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString();
            return scheduledId ? [scheduledActivityNames.get(scheduledId)] : [];
          });
          const packingTimeout = (history.events ?? []).find((event) => {
            const attributes = event.activityTaskTimedOutEventAttributes;
            return attributes && scheduledActivityNames.get(attributes.scheduledEventId?.toString()) === 'packOrder';
          });

          assert.equal((await handle.describe()).status.name, 'CANCELLED');
          assert.equal(state.status, 'cancelled');
          assert.equal(state.compensationProgress?.status, 'completed');
          assert.equal(state.steps.find((step) => step.id === 'packing')?.status, 'cancelled');
          assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
          assert.equal(state.trackingNumber, undefined);
          assert.equal(ledger.debitCount, 1);
          assert.equal(ledger.refundCount, 1);
          assert.equal(ledger.totalCharged - ledger.totalRefunded, 0);
          assert.equal(completedActivityNames.includes('refundPayment'), true);
          assert.equal(completedActivityNames.includes('releaseInventory'), true);
          assert.equal([...scheduledActivityNames.values()].includes('shipOrder'), false);
          assert.equal(decodeTimeoutType(
            packingTimeout?.activityTaskTimedOutEventAttributes?.failure?.timeoutFailureInfo?.timeoutType,
          ), 'HEARTBEAT');
        } finally {
          if ((await handle.describe()).status.name === 'RUNNING') await handle.cancel();
        }
      });

      await t.test('打包期间取消会补偿且不会发货', async () => {
        const handle = await start('heartbeat');
        try {
          await waitForState(handle, '等待人工确认', (state) => state.status === 'waiting_approval');
          await handle.signal(APPROVE_SIGNAL);
          const heartbeat = await waitForPackingHeartbeat(handle);
          assert.equal(heartbeat.attempt, 1);
          assert.equal(heartbeat.phase, 'packing');

          await handle.cancel();
          await assert.rejects(
            handle.result(),
            (error: unknown) => error instanceof WorkflowFailedError && error.cause instanceof CancelledFailure,
          );
          const state = await handle.query<OrderState>(STATE_QUERY);
          const ledger = getPaymentStore().get(handle.workflowId);
          const history = await handle.fetchHistory();
          const scheduledActivityNames = new Map(
            (history.events ?? [])
              .filter((event) => event.activityTaskScheduledEventAttributes)
              .map((event) => [
                event.eventId?.toString(),
                event.activityTaskScheduledEventAttributes?.activityType?.name,
              ]),
          );
          const completedActivityNames = (history.events ?? []).flatMap((event) => {
            const scheduledId = event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString();
            return scheduledId ? [scheduledActivityNames.get(scheduledId)] : [];
          });

          assert.equal(state.status, 'cancelled');
          assert.equal(state.steps.find((step) => step.id === 'packing')?.status, 'cancelled');
          assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
          assert.equal(state.trackingNumber, undefined);
          assert.equal(ledger.refundCount, 1);
          assert.equal(ledger.totalRefunded, 299);
          assert.equal(completedActivityNames.includes('refundPayment'), true);
          assert.equal(completedActivityNames.includes('releaseInventory'), true);
          assert.equal(completedActivityNames.includes('shipOrder'), false);
        } finally {
          if ((await handle.describe()).status.name === 'RUNNING') await handle.cancel();
        }
      });
    });
  } finally {
    closePaymentStore();
    await environment.teardown();
    if (previousPaymentPath === undefined) delete process.env.PAYMENT_DB_PATH;
    else process.env.PAYMENT_DB_PATH = previousPaymentPath;
    await rm(directory, { recursive: true, force: true });
  }
});
