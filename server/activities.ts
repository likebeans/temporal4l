import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { OrderInput, PackingCheckpoint } from '../shared/types';
import { getPaymentStore } from './payment-ledger';

export interface OrderActivityArgs {
  input: OrderInput;
  workflowId: string;
  total: number;
}

export interface PaymentResult {
  attempt: number;
}

export type OrderActivities = {
  reserveInventory(args: OrderActivityArgs): Promise<void>;
  chargePayment(args: OrderActivityArgs): Promise<PaymentResult>;
  packOrder(args: OrderActivityArgs): Promise<PackingCheckpoint>;
  shipOrder(args: OrderActivityArgs): Promise<string>;
  refundPayment(args: OrderActivityArgs): Promise<void>;
  releaseInventory(args: OrderActivityArgs): Promise<void>;
};

const STEP_DELAY_MS = 1_400;
const PACKING_BATCHES = 12;
const BATCH_DELAY_MS = 1_000;

async function simulatedRequest(): Promise<void> {
  const context = Context.current();
  // 心跳把 Server 的取消通知送到本地上下文；sleep 负责响应已送达的取消。
  for (let elapsed = 0; elapsed < STEP_DELAY_MS; elapsed += 200) {
    context.heartbeat();
    await context.sleep(200);
  }
}

export async function reserveInventory(_args: OrderActivityArgs): Promise<void> {
  await simulatedRequest();
}

export async function chargePayment({ input, workflowId, total }: OrderActivityArgs): Promise<PaymentResult> {
  const attempt = Context.current().info.attempt;
  const payments = getPaymentStore();
  payments.recordAttempt(workflowId, attempt);
  await simulatedRequest();

  if (input.scenario === 'failure' || (input.scenario === 'retry' && attempt < 3)) {
    payments.recordFailure(workflowId, attempt, '模拟支付网关失败，尚未扣款');
    throw ApplicationFailure.retryable(`模拟支付网关第 ${attempt} 次调用失败`, 'PaymentGatewayUnavailable');
  }

  const { reused } = payments.charge(workflowId, total, attempt);
  if (input.scenario === 'idempotency' && !reused) {
    // 账本事务已经提交；在向 Temporal 报告完成前失败，重试必须复用稳定幂等键。
    payments.recordFailure(workflowId, attempt, '扣款已入账，但本次 Activity 在报告成功前故意失败');
    throw ApplicationFailure.retryable('模拟扣款成功后响应丢失', 'PaymentResponseLost');
  }
  return { attempt };
}

export async function packOrder({ input }: OrderActivityArgs): Promise<PackingCheckpoint> {
  const context = Context.current();
  const previous = context.info.heartbeatDetails as Partial<PackingCheckpoint> | undefined;
  const resumedFrom = typeof previous?.completedBatches === 'number'
    ? Math.min(PACKING_BATCHES, Math.max(0, Math.floor(previous.completedBatches))) : 0;
  let checkpoint: PackingCheckpoint = {
    completedBatches: resumedFrom,
    totalBatches: PACKING_BATCHES,
    attempt: context.info.attempt,
    resumedFrom,
    phase: 'packing',
    updatedAt: new Date().toISOString(),
  };
  context.heartbeat(checkpoint);

  for (let batch = resumedFrom + 1; batch <= PACKING_BATCHES; batch += 1) {
    await context.sleep(BATCH_DELAY_MS);
    checkpoint = { ...checkpoint, completedBatches: batch, updatedAt: new Date().toISOString() };
    context.heartbeat(checkpoint);
    context.log.info('打包批次完成', { batch, attempt: checkpoint.attempt, resumedFrom });

    if (input.scenario === 'heartbeat_timeout' && context.info.attempt === 1 && batch === 3) {
      checkpoint = { ...checkpoint, phase: 'paused', updatedAt: new Date().toISOString() };
      context.heartbeat(checkpoint);
      // 暂停业务和心跳，超过 5 秒心跳期限，让 Server 安排真实的下一次尝试。
      await context.sleep(8_000);
      // 旧尝试不再推进业务；即使服务端通知未到达，也在有限时间内退出。
      throw ApplicationFailure.retryable('故障注入结束：本次尝试已超过心跳期限', 'HeartbeatPauseFinished');
    }
  }

  checkpoint = { ...checkpoint, phase: 'completed', updatedAt: new Date().toISOString() };
  context.heartbeat(checkpoint);
  return checkpoint;
}

export async function shipOrder({ workflowId }: OrderActivityArgs): Promise<string> {
  await simulatedRequest();
  return `TML-${workflowId.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toUpperCase()}`;
}

export async function refundPayment({ workflowId }: OrderActivityArgs): Promise<void> {
  await simulatedRequest();
  getPaymentStore().refund(workflowId, Context.current().info.attempt);
}

export async function releaseInventory(_args: OrderActivityArgs): Promise<void> {
  await simulatedRequest();
}
