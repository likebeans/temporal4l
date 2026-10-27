import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import { ActivityFailure, ApplicationFailure, CancelledFailure, TimeoutFailure } from '@temporalio/common';
import { WorkflowFailedError, WorkflowUpdateFailedError, type WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { OrderActivities, OrderActivityArgs } from '../server/activities';
import { orderWorkflow } from '../server/workflows';
import {
  APPROVE_SIGNAL,
  APPROVE_UPDATE,
  STATE_QUERY,
  type ApprovalUpdateResult,
  type OrderInput,
  type OrderState,
  type OrderStatus,
} from '../shared/types';

const workflowsPath = fileURLToPath(new URL('../server/workflows.ts', import.meta.url));

function orderInput(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    customerName: 'Temporal 学习者',
    productId: 'keyboard',
    quantity: 2,
    scenario: 'normal',
    approvalTimeoutSeconds: 30,
    ...overrides,
  };
}

interface ActivityRecord {
  paymentAttempts: number[];
  // refundPayment 会幂等查账；调用次数不代表实际退款笔数。
  refundChecks: number;
  releases: number;
  shipments: number;
  reserveGate?: Promise<void>;
  refundGate?: Promise<void>;
  shipGate?: Promise<void>;
  failRefund?: boolean;
  stopPackingHeartbeats?: boolean;
}

function createTestActivities(records: Map<string, ActivityRecord>): OrderActivities {
  const recordFor = (workflowId: string): ActivityRecord => {
    const existing = records.get(workflowId);
    if (existing) return existing;
    const created = { paymentAttempts: [], refundChecks: 0, releases: 0, shipments: 0 };
    records.set(workflowId, created);
    return created;
  };
  const pause = () => Context.current().sleep(5);

  return {
    async reserveInventory({ workflowId }) {
      const record = recordFor(workflowId);
      await record.reserveGate;
      await pause();
    },
    async chargePayment({ input, workflowId }: OrderActivityArgs) {
      const attempt = Context.current().info.attempt;
      recordFor(workflowId).paymentAttempts.push(attempt);
      await pause();
      if (input.scenario === 'failure' || (input.scenario === 'retry' && attempt < 3)) {
        throw ApplicationFailure.retryable(`测试支付第 ${attempt} 次失败`, 'PaymentGatewayUnavailable');
      }
      return { attempt };
    },
    async packOrder({ workflowId }) {
      if (recordFor(workflowId).stopPackingHeartbeats) {
        Context.current().heartbeat();
        await Context.current().sleep(6_000);
      }
      await pause();
      return {
        completedBatches: 12,
        totalBatches: 12,
        attempt: Context.current().info.attempt,
        resumedFrom: 0,
        phase: 'completed',
        updatedAt: new Date().toISOString(),
      };
    },
    async shipOrder({ workflowId }) {
      const record = recordFor(workflowId);
      record.shipments += 1;
      await record.shipGate;
      await pause();
      return `TEST-${workflowId}`;
    },
    async refundPayment({ workflowId }) {
      const record = recordFor(workflowId);
      await record.refundGate;
      await pause();
      record.refundChecks += 1;
      if (record.failRefund) {
        throw ApplicationFailure.nonRetryable('测试退款失败', 'RefundFailed');
      }
    },
    async releaseInventory({ workflowId }) {
      await pause();
      recordFor(workflowId).releases += 1;
    },
  };
}

async function waitForStatus(
  handle: WorkflowHandle<typeof orderWorkflow>,
  expected: OrderStatus,
): Promise<OrderState> {
  let lastState: OrderState | undefined;
  for (let index = 0; index < 400; index += 1) {
    try {
      lastState = await handle.query<OrderState>(STATE_QUERY);
      if (lastState.status === expected) return lastState;
    } catch {
      // 首个 Workflow Task 完成前 Query handler 尚不可见，稍后再查。
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等待状态 ${expected} 超时，最后状态：${lastState?.status ?? '不可查询'}`);
}

async function waitForState(
  handle: WorkflowHandle<typeof orderWorkflow>,
  description: string,
  predicate: (state: OrderState) => boolean,
): Promise<OrderState> {
  let lastState: OrderState | undefined;
  for (let index = 0; index < 400; index += 1) {
    try {
      lastState = await handle.query<OrderState>(STATE_QUERY);
      if (predicate(lastState)) return lastState;
    } catch {
      // 首个 Workflow Task 完成前 Query handler 尚不可见，稍后再查。
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等待${description}超时，最后状态：${JSON.stringify(lastState)}`);
}

async function expectUpdateFailure(
  operation: Promise<unknown>,
  type: string,
  message: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof WorkflowUpdateFailedError);
    assert.ok(error.cause instanceof ApplicationFailure);
    assert.equal(error.cause.type, type);
    assert.equal(error.cause.nonRetryable, true);
    assert.match(error.cause.message, message);
    return true;
  });
}

async function countUpdateHistoryEvents(
  handle: WorkflowHandle<typeof orderWorkflow>,
  updateId: string,
): Promise<{ accepted: number; completed: number }> {
  const history = await handle.fetchHistory();
  let accepted = 0;
  let completed = 0;
  for (const event of history.events ?? []) {
    const acceptedAttributes = event.workflowExecutionUpdateAcceptedEventAttributes;
    const completedAttributes = event.workflowExecutionUpdateCompletedEventAttributes;
    if (
      acceptedAttributes?.acceptedRequest?.meta?.updateId === updateId
      || acceptedAttributes?.protocolInstanceId === updateId
    ) accepted += 1;
    if (completedAttributes?.meta?.updateId === updateId) completed += 1;
  }
  return { accepted, completed };
}

async function expectWorkflowFailure(
  handle: WorkflowHandle<typeof orderWorkflow>,
): Promise<WorkflowFailedError> {
  try {
    await handle.result();
  } catch (error) {
    assert.ok(error instanceof WorkflowFailedError);
    return error;
  }
  assert.fail('工作流应当以失败或取消结束');
}

test('订单工作流展示成功、重试、失败、超时与取消', { timeout: 180_000 }, async (t) => {
  // 默认启动官方轻量开发服务；并行验证时也可复用指定的本地 Temporal。
  const environment = process.env.TEMPORAL_TEST_ADDRESS
    ? await TestWorkflowEnvironment.createFromExistingServer({
        address: process.env.TEMPORAL_TEST_ADDRESS,
        namespace: process.env.TEMPORAL_TEST_NAMESPACE || 'default',
      })
    : await TestWorkflowEnvironment.createLocal();
  const taskQueue = `order-workflow-test-${randomUUID()}`;
  const records = new Map<string, ActivityRecord>();

  try {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath,
      activities: createTestActivities(records),
    });

    await worker.runUntil(async () => {
      const start = (
        input: OrderInput,
        workflowId = `test-order-${randomUUID()}`,
      ) => environment.client.workflow.start(orderWorkflow, {
        taskQueue,
        workflowId,
        args: [input],
      });

      await t.test('正常订单等待确认信号后完成', async () => {
        const handle = await start(orderInput());
        const waiting = await waitForStatus(handle, 'waiting_approval');

        assert.equal(waiting.total, 598);
        assert.deepEqual(
          waiting.steps.map(({ id, status }) => ({ id, status })),
          [
            { id: 'inventory', status: 'completed' },
            { id: 'payment', status: 'completed' },
            { id: 'approval', status: 'waiting' },
            { id: 'shipping', status: 'pending' },
          ],
        );
        assert.ok(waiting.approvalDeadline);

        await handle.signal(APPROVE_SIGNAL);
        const result = await handle.result();

        assert.equal(result.status, 'completed');
        assert.equal(result.trackingNumber, `TEST-${handle.workflowId}`);
        assert.ok(result.approvedAt);
        assert.equal(result.approvalMethod, 'signal');
        assert.equal(result.approvalUpdateId, undefined);
        assert.match(result.steps.find((step) => step.id === 'approval')?.detail ?? '', /Signal/);
        assert.ok(result.steps.every((step) => step.status === 'completed'));
      });

      await t.test('有效 Update 返回确认结果并记录确认方式', async () => {
        const handle = await start(orderInput());
        await waitForStatus(handle, 'waiting_approval');
        const updateId = `approval-${randomUUID()}`;

        const approval = await handle.executeUpdate<ApprovalUpdateResult, [{ confirmed: boolean }]>(
          APPROVE_UPDATE,
          { updateId, args: [{ confirmed: true }] },
        );
        const result = await handle.result();

        assert.deepEqual(approval, {
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          updateId,
          approvedAt: approval.approvedAt,
          status: 'approved',
        });
        assert.match(approval.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(result.approvalMethod, 'update');
        assert.equal(result.approvalUpdateId, updateId);
        assert.equal(result.approvedAt, approval.approvedAt);
        assert.equal(result.steps.find((step) => step.id === 'approval')?.kind, 'Signal / Update');
        assert.match(result.steps.find((step) => step.id === 'approval')?.detail ?? '', /Update/);
      });

      await t.test('未勾选核对确认时拒绝 Update 且继续等待', async () => {
        const handle = await start(orderInput());
        await waitForStatus(handle, 'waiting_approval');
        const updateId = `approval-unconfirmed-${randomUUID()}`;

        await expectUpdateFailure(
          handle.executeUpdate(APPROVE_UPDATE, {
            updateId,
            args: [{ confirmed: false }],
          }),
          'ApprovalConfirmationRequired',
          /请先确认已核对订单信息/,
        );

        const waiting = await handle.query<OrderState>(STATE_QUERY);
        assert.equal(waiting.status, 'waiting_approval');
        assert.equal(waiting.approvedAt, undefined);
        assert.equal(waiting.approvalMethod, undefined);
        assert.deepEqual(await countUpdateHistoryEvents(handle, updateId), {
          accepted: 0,
          completed: 0,
        });

        await handle.signal(APPROVE_SIGNAL);
        assert.equal((await handle.result()).status, 'completed');
      });

      await t.test('付款完成前拒绝提前 Update', async () => {
        const workflowId = `test-order-${randomUUID()}`;
        let releaseReserve!: () => void;
        const reserveGate = new Promise<void>((resolve) => { releaseReserve = resolve; });
        records.set(workflowId, {
          paymentAttempts: [],
          refundChecks: 0,
          releases: 0,
          shipments: 0,
          reserveGate,
        });
        const handle = await start(orderInput(), workflowId);
        await waitForState(handle, '库存预留开始', (state) => (
          state.status === 'running'
          && state.steps.find((step) => step.id === 'inventory')?.status === 'running'
        ));
        const updateId = `approval-early-${randomUUID()}`;

        try {
          await expectUpdateFailure(
            handle.executeUpdate(APPROVE_UPDATE, {
              updateId,
              args: [{ confirmed: true }],
            }),
            'ApprovalNotAllowed',
            /当前订单不允许确认/,
          );
          assert.deepEqual(await countUpdateHistoryEvents(handle, updateId), {
            accepted: 0,
            completed: 0,
          });
        } finally {
          releaseReserve();
        }

        await waitForStatus(handle, 'waiting_approval');
        await handle.signal(APPROVE_SIGNAL);
        assert.equal((await handle.result()).status, 'completed');
      });

      await t.test('相同 Update ID 返回同一结果，不同 ID 的二次确认被拒绝', async () => {
        const handle = await start(orderInput());
        await waitForStatus(handle, 'waiting_approval');
        let releaseShipping!: () => void;
        const shipGate = new Promise<void>((resolve) => { releaseShipping = resolve; });
        records.get(handle.workflowId)!.shipGate = shipGate;
        const updateId = `approval-idempotent-${randomUUID()}`;

        try {
          const first = await handle.executeUpdate<ApprovalUpdateResult, [{ confirmed: boolean }]>(
            APPROVE_UPDATE,
            { updateId, args: [{ confirmed: true }] },
          );
          await waitForState(handle, '发货步骤进入运行状态', (state) => (
            state.status === 'running'
            && state.steps.find((step) => step.id === 'shipping')?.status === 'running'
          ));
          const retried = await handle.executeUpdate<ApprovalUpdateResult, [{ confirmed: boolean }]>(
            APPROVE_UPDATE,
            { updateId, args: [{ confirmed: true }] },
          );

          assert.deepEqual(retried, first);
          assert.deepEqual(await countUpdateHistoryEvents(handle, updateId), {
            accepted: 1,
            completed: 1,
          });

          await expectUpdateFailure(
            handle.executeUpdate(APPROVE_UPDATE, {
              updateId: `approval-second-${randomUUID()}`,
              args: [{ confirmed: true }],
            }),
            'ApprovalNotAllowed',
            /当前订单不允许确认/,
          );
        } finally {
          releaseShipping();
        }

        const result = await handle.result();
        assert.equal(result.approvalUpdateId, updateId);
        assert.equal(records.get(handle.workflowId)?.shipments, 1);
      });

      await t.test('重复 Signal 与 Signal / Update 竞争只确认并发货一次', async () => {
        const handle = await start(orderInput());
        await waitForStatus(handle, 'waiting_approval');
        let releaseShipping!: () => void;
        const shipGate = new Promise<void>((resolve) => { releaseShipping = resolve; });
        records.get(handle.workflowId)!.shipGate = shipGate;
        const updateId = `approval-race-${randomUUID()}`;

        const signalOne = handle.signal(APPROVE_SIGNAL);
        const signalTwo = handle.signal(APPROVE_SIGNAL);
        const update = handle.executeUpdate<ApprovalUpdateResult, [{ confirmed: boolean }]>(
          APPROVE_UPDATE,
          { updateId, args: [{ confirmed: true }] },
        );
        const updateOutcome = update.then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );

        try {
          await Promise.all([signalOne, signalTwo]);
          const running = await waitForState(handle, '竞争后发货步骤进入运行状态', (state) => (
            state.status === 'running'
            && state.steps.find((step) => step.id === 'shipping')?.status === 'running'
          ));
          const outcome = await updateOutcome;

          if (outcome.status === 'fulfilled') {
            assert.equal(running.approvalMethod, 'update');
            assert.equal(running.approvalUpdateId, updateId);
            assert.equal(outcome.value.updateId, updateId);
          } else {
            assert.equal(running.approvalMethod, 'signal');
            assert.equal(running.approvalUpdateId, undefined);
            assert.ok(outcome.reason instanceof WorkflowUpdateFailedError);
            assert.ok(outcome.reason.cause instanceof ApplicationFailure);
            assert.equal(outcome.reason.cause.type, 'ApprovalNotAllowed');
          }
        } finally {
          releaseShipping();
        }

        const result = await handle.result();
        assert.ok(result.approvalMethod === 'signal' || result.approvalMethod === 'update');
        if (result.approvalMethod === 'update') assert.equal(result.approvalUpdateId, updateId);
        assert.equal(records.get(handle.workflowId)?.shipments, 1);
      });

      await t.test('支付前两次失败并在第 3 次自动重试成功', async () => {
        const handle = await start(orderInput({ scenario: 'retry' }));
        const waiting = await waitForStatus(handle, 'waiting_approval');

        assert.deepEqual(records.get(handle.workflowId)?.paymentAttempts, [1, 2, 3]);
        assert.match(waiting.steps.find((step) => step.id === 'payment')?.detail ?? '', /第 3 次/);

        await handle.signal(APPROVE_SIGNAL);
        assert.equal((await handle.result()).status, 'completed');
      });

      await t.test('支付重试耗尽后失败并释放已预留库存', async () => {
        const handle = await start(orderInput({ scenario: 'failure' }));
        const failure = await expectWorkflowFailure(handle);
        const state = await handle.query<OrderState>(STATE_QUERY);

        assert.ok(failure.cause instanceof ApplicationFailure);
        assert.equal(failure.cause.nonRetryable, true);
        assert.deepEqual(records.get(handle.workflowId)?.paymentAttempts, [1, 2, 3]);
        assert.equal(records.get(handle.workflowId)?.refundChecks, 1);
        assert.equal(records.get(handle.workflowId)?.releases, 1);
        assert.equal(state.status, 'failed');
        assert.match(state.error ?? '', /第 3 次/);
        assert.match(state.compensation ?? '', /释放库存成功/);
        assert.equal(state.steps.find((step) => step.id === 'payment')?.status, 'failed');
        assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
      });

      await t.test('没有取消请求时心跳超时重试耗尽仍为 FAILED', async () => {
        const handle = await start(orderInput({ scenario: 'heartbeat' }));
        await waitForStatus(handle, 'waiting_approval');
        records.get(handle.workflowId)!.stopPackingHeartbeats = true;
        await handle.signal(APPROVE_SIGNAL);

        const failure = await expectWorkflowFailure(handle);
        const state = await handle.query<OrderState>(STATE_QUERY);

        assert.ok(failure.cause instanceof ApplicationFailure);
        assert.equal(failure.cause.type, 'OrderWorkflowFailed');
        assert.ok(failure.cause.cause instanceof ActivityFailure);
        assert.ok(failure.cause.cause.cause instanceof TimeoutFailure);
        assert.equal(failure.cause.cause.cause.timeoutType, 'HEARTBEAT');
        assert.equal((await handle.describe()).status.name, 'FAILED');
        assert.equal(state.status, 'failed');
        assert.equal(state.compensationProgress?.status, 'completed');
        assert.equal(state.steps.find((step) => step.id === 'packing')?.status, 'failed');
        assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
        assert.equal(records.get(handle.workflowId)?.refundChecks, 1);
        assert.equal(records.get(handle.workflowId)?.releases, 1);
        assert.equal(records.get(handle.workflowId)?.shipments, 0);
      });

      await t.test('确认超时后退款并释放库存', async () => {
        const handle = await start(orderInput({ scenario: 'timeout', approvalTimeoutSeconds: 1 }));
        await expectWorkflowFailure(handle);
        const state = await handle.query<OrderState>(STATE_QUERY);

        assert.equal(records.get(handle.workflowId)?.refundChecks, 1);
        assert.equal(records.get(handle.workflowId)?.releases, 1);
        assert.equal(state.status, 'failed');
        assert.match(state.error ?? '', /确认超时/);
        assert.match(state.compensation ?? '', /退款检查完成.*释放库存成功/);
        assert.equal(state.steps.find((step) => step.id === 'approval')?.status, 'failed');
        assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
      });

      await t.test('补偿进度可查询，且退款失败不会阻止释放库存', async () => {
        const workflowId = `test-order-${randomUUID()}`;
        let releaseRefund!: () => void;
        const refundGate = new Promise<void>((resolve) => { releaseRefund = resolve; });
        records.set(workflowId, {
          paymentAttempts: [],
          refundChecks: 0,
          releases: 0,
          shipments: 0,
          refundGate,
          failRefund: true,
        });
        const handle = await start(
          orderInput({ scenario: 'timeout', approvalTimeoutSeconds: 0 }),
          workflowId,
        );

        const running = await waitForState(handle, '补偿开始', (state) => (
          state.compensationProgress?.status === 'running'
          && state.compensationProgress.steps[0]?.id === 'refund'
          && state.compensationProgress.steps[0]?.status === 'running'
        ));
        assert.deepEqual(
          running.compensationProgress?.steps.map(({ id, status }) => ({ id, status })),
          [
            { id: 'refund', status: 'running' },
            { id: 'inventory', status: 'pending' },
          ],
        );
        assert.equal(records.get(workflowId)?.releases, 0);

        releaseRefund();
        await expectWorkflowFailure(handle);
        const state = await handle.query<OrderState>(STATE_QUERY);

        assert.equal(records.get(workflowId)?.refundChecks, 1);
        assert.equal(records.get(workflowId)?.releases, 1);
        assert.equal(state.compensationProgress?.status, 'failed');
        assert.deepEqual(
          state.compensationProgress?.steps.map(({ id, status }) => ({ id, status })),
          [
            { id: 'refund', status: 'failed' },
            { id: 'inventory', status: 'completed' },
          ],
        );
        assert.match(state.compensationProgress?.steps[0]?.detail ?? '', /测试退款失败/);
        assert.match(state.compensation ?? '', /退款或核对扣款失败.*释放库存成功/);
      });

      await t.test('取消工作流后在不可取消作用域中完成补偿', async () => {
        const handle = await start(orderInput());
        await waitForStatus(handle, 'waiting_approval');

        await handle.cancel();
        const failure = await expectWorkflowFailure(handle);
        const state = await handle.query<OrderState>(STATE_QUERY);

        assert.ok(failure.cause instanceof CancelledFailure);
        assert.equal(records.get(handle.workflowId)?.refundChecks, 1);
        assert.equal(records.get(handle.workflowId)?.releases, 1);
        assert.equal(state.status, 'cancelled');
        assert.match(state.compensation ?? '', /退款检查完成.*释放库存成功/);
        assert.equal(state.steps.find((step) => step.id === 'approval')?.status, 'cancelled');
        assert.equal(state.steps.find((step) => step.id === 'shipping')?.status, 'cancelled');
      });
    });
  } finally {
    await environment.teardown();
  }
});
