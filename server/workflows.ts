import {
  ApplicationFailure,
  CancellationScope,
  condition,
  currentUpdateInfo,
  defineQuery,
  defineSignal,
  defineUpdate,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { OrderActivities, OrderActivityArgs } from './activities';
import {
  APPROVE_SIGNAL,
  APPROVE_UPDATE,
  PRODUCTS,
  STATE_QUERY,
  type ApprovalUpdateInput,
  type ApprovalUpdateResult,
  type OrderInput,
  type OrderState,
  type OrderStep,
  type StepId,
  type StepStatus,
} from '../shared/types';

const stateQuery = defineQuery<OrderState>(STATE_QUERY);
const approveSignal = defineSignal(APPROVE_SIGNAL);
const approveUpdate = defineUpdate<ApprovalUpdateResult, [ApprovalUpdateInput]>(APPROVE_UPDATE);

const sharedActivityOptions = {
  startToCloseTimeout: '10 seconds' as const,
  heartbeatTimeout: '5 seconds' as const,
  cancellationType: 'WAIT_CANCELLATION_COMPLETED' as const,
  retry: {
    maximumAttempts: 3,
  },
};

const {
  reserveInventory,
  shipOrder,
  refundPayment,
  releaseInventory,
} = proxyActivities<Pick<
  OrderActivities,
  'reserveInventory' | 'shipOrder' | 'refundPayment' | 'releaseInventory'
>>(sharedActivityOptions);

const { chargePayment } = proxyActivities<Pick<OrderActivities, 'chargePayment'>>({
  ...sharedActivityOptions,
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '3 seconds',
  },
});

const { packOrder } = proxyActivities<Pick<OrderActivities, 'packOrder'>>({
  ...sharedActivityOptions,
  startToCloseTimeout: '45 seconds',
  scheduleToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '1 second' },
});

function timestamp(): string {
  // Workflow 沙箱中的时间来自历史事件，重放时仍然确定。
  return new Date().toISOString();
}

function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && cause !== error) {
    const causeMessage = failureDetail(cause);
    if (causeMessage && !error.message.includes(causeMessage)) {
      return `${error.message}；原因：${causeMessage}`;
    }
  }
  return error.message || error.name;
}

export async function orderWorkflow(input: OrderInput): Promise<OrderState> {
  const workflowId = workflowInfo().workflowId;
  const createdAt = timestamp();
  const product = PRODUCTS.find((candidate) => candidate.id === input.productId);
  const total = (product?.price ?? 0) * input.quantity;
  const steps: OrderStep[] = [
    { id: 'inventory', label: '预留库存', kind: 'Activity', status: 'pending', detail: '等待执行 reserveInventory' },
    { id: 'payment', label: '收取货款', kind: 'Activity', status: 'pending', detail: '等待执行 chargePayment' },
    { id: 'approval', label: '人工确认', kind: 'Signal / Update', status: 'pending', detail: '付款成功后等待 approveOrder Signal 或 approveOrderUpdate Update' },
    { id: 'shipping', label: '创建发货单', kind: 'Activity', status: 'pending', detail: '确认后执行 shipOrder' },
  ];
  if (input.scenario === 'heartbeat' || input.scenario === 'heartbeat_timeout') {
    steps.splice(3, 0, {
      id: 'packing', label: '分批打包', kind: 'Activity', status: 'pending',
      detail: '确认后执行 packOrder，通过心跳保存批次检查点',
    });
  }
  let state: OrderState = {
    workflowId,
    input,
    status: 'running',
    steps,
    total,
    createdAt,
    updatedAt: createdAt,
    compensationProgress: { status: 'idle', steps: [] },
  };
  let approvalReceived = false;
  let inventoryReserved = false;
  let paymentCharged = false;
  let paymentAttempted = false;

  const updateStep = (id: StepId, status: StepStatus, detail: string): void => {
    const step = state.steps.find((candidate) => candidate.id === id);
    if (step) {
      step.status = status;
      step.detail = detail;
    }
    state.updatedAt = timestamp();
  };

  const applyApproval = (method: 'signal' | 'update', updateId?: string): boolean => {
    if (state.status !== 'waiting_approval' || approvalReceived) return false;
    approvalReceived = true;
    state.status = 'running';
    state.approvedAt = timestamp();
    state.approvalMethod = method;
    if (method === 'update' && updateId) state.approvalUpdateId = updateId;
    const methodLabel = method === 'signal' ? 'Signal' : `Update（${updateId}）`;
    updateStep('approval', 'completed', `已在 ${state.approvedAt} 通过 ${methodLabel} 完成人工确认`);
    return true;
  };

  const validateApprovalUpdate = ({ confirmed }: ApprovalUpdateInput): void => {
    if (confirmed !== true) {
      throw ApplicationFailure.nonRetryable(
        '请先确认已核对订单信息',
        'ApprovalConfirmationRequired',
      );
    }
    if (state.status !== 'waiting_approval' || approvalReceived) {
      throw ApplicationFailure.nonRetryable('当前订单不允许确认', 'ApprovalNotAllowed');
    }
  };

  // 尽早注册 Query、Signal 与 Update，让客户端及时观察和驱动流程。
  setHandler(stateQuery, () => state);
  setHandler(approveSignal, () => {
    // Signal 没有返回值；提前或重复确认继续静默忽略。
    applyApproval('signal');
  });
  setHandler(approveUpdate, (input) => {
    validateApprovalUpdate(input);
    const updateInfo = currentUpdateInfo();
    if (!updateInfo || !applyApproval('update', updateInfo.id)) {
      throw ApplicationFailure.nonRetryable('当前订单不允许确认', 'ApprovalNotAllowed');
    }
    return {
      workflowId,
      runId: workflowInfo().runId,
      updateId: updateInfo.id,
      approvedAt: state.approvedAt!,
      status: 'approved',
    };
  }, { validator: validateApprovalUpdate });

  const activityArgs: OrderActivityArgs = { input, workflowId, total };

  const markUnfinishedCancelled = (reason: string): void => {
    for (const step of state.steps) {
      if (step.status === 'pending' || step.status === 'running' || step.status === 'waiting') {
        step.status = 'cancelled';
        step.detail = reason;
      }
    }
    state.updatedAt = timestamp();
  };

  const compensate = async (): Promise<void> => {
    // 任意场景都可能已扣款却未收到 Activity 成功结果，支付尝试后必须幂等查账并退款。
    const needsRefund = paymentCharged || paymentAttempted;
    const progress: NonNullable<OrderState['compensationProgress']> = {
      status: 'running',
      steps: [],
    };
    if (needsRefund) progress.steps.push({ id: 'refund', label: '退款或核对扣款', status: 'pending' });
    if (inventoryReserved) progress.steps.push({ id: 'inventory', label: '释放库存', status: 'pending' });
    state.compensationProgress = progress;
    const outcomes: string[] = [];
    for (const step of progress.steps) {
      step.status = 'running';
      state.compensation = `正在${step.label}`;
      state.updatedAt = timestamp();
      try {
        if (step.id === 'refund') {
          await refundPayment(activityArgs);
          paymentCharged = false;
          step.detail = '退款检查完成；如有扣款，已幂等退款';
          outcomes.push(step.detail);
        } else {
          await releaseInventory(activityArgs);
          inventoryReserved = false;
          step.detail = '释放库存成功';
          outcomes.push(step.detail);
        }
        step.status = 'completed';
      } catch (error) {
        // 每项补偿独立执行：退款失败也不能阻止释放库存。
        step.status = 'failed';
        step.detail = `${step.label}失败：${failureDetail(error)}`;
        outcomes.push(step.detail);
      }
      state.updatedAt = timestamp();
    }
    progress.status = progress.steps.some((step) => step.status === 'failed') ? 'failed' : 'completed';
    state.compensation = outcomes.length > 0 ? outcomes.join('；') : '没有已完成的业务步骤，无需补偿';
    state.updatedAt = timestamp();
  };

  try {
    updateStep('inventory', 'running', '正在调用 reserveInventory Activity');
    await reserveInventory(activityArgs);
    inventoryReserved = true;
    updateStep('inventory', 'completed', '库存已预留');

    updateStep('payment', 'running', '正在调用 chargePayment Activity；失败时由 Temporal 自动重试');
    paymentAttempted = true;
    const payment = await chargePayment(activityArgs);
    paymentCharged = true;
    updateStep('payment', 'completed', `付款成功（第 ${payment.attempt} 次尝试）`);

    const approvalTimeoutMs = Math.max(0, input.approvalTimeoutSeconds) * 1_000;
    state.status = 'waiting_approval';
    state.approvalDeadline = new Date(Date.now() + approvalTimeoutMs).toISOString();
    updateStep('approval', 'waiting', `等待 approveOrder Signal 或 approveOrderUpdate Update，截止 ${state.approvalDeadline}`);

    const approvedInTime = await condition(() => approvalReceived, approvalTimeoutMs);
    if (!approvedInTime) {
      updateStep('approval', 'failed', `确认超时：${input.approvalTimeoutSeconds} 秒内未收到 Signal 或 Update`);
      updateStep('shipping', 'cancelled', '因人工确认超时，未创建发货单');
      throw ApplicationFailure.nonRetryable(
        `人工确认超时（${input.approvalTimeoutSeconds} 秒）`,
        'ApprovalTimedOut',
      );
    }

    state.status = 'running';
    if (input.scenario === 'heartbeat' || input.scenario === 'heartbeat_timeout') {
      updateStep('packing', 'running', '分批打包中；进度与检查点来自 Activity heartbeat');
      state.packing = await packOrder(activityArgs);
      updateStep('packing', 'completed', `已打包 ${state.packing.completedBatches} 批；第 ${state.packing.attempt} 次尝试，从第 ${state.packing.resumedFrom} 批恢复`);
    }
    updateStep('shipping', 'running', '正在调用 shipOrder Activity');
    const trackingNumber = await shipOrder(activityArgs);
    state.trackingNumber = trackingNumber;
    updateStep('shipping', 'completed', `发货单已创建：${trackingNumber}`);
    state.status = 'completed';
    state.updatedAt = timestamp();
    return state;
  } catch (error) {
    const cancellationScope = CancellationScope.current();
    if (isCancellation(error) || cancellationScope.consideredCancelled) {
      state.status = 'cancelled';
      state.error = '工作流收到取消请求';
      markUnfinishedCancelled('工作流已取消，此步骤不再执行');
      await CancellationScope.nonCancellable(compensate);
      // 停止心跳的 Activity 可能先返回超时，重抛作用域的取消异常才能保持 CANCELLED。
      if (cancellationScope.consideredCancelled) await cancellationScope.cancelRequested;
      throw error;
    }

    const originalFailure = failureDetail(error);
    state.status = 'failed';
    state.error = originalFailure;

    const runningStep = state.steps.find((step) => step.status === 'running');
    if (runningStep) {
      runningStep.status = 'failed';
      runningStep.detail = `${runningStep.label}失败：${originalFailure}`;
    }
    for (const step of state.steps) {
      if (step.status === 'pending' || step.status === 'waiting') {
        step.status = 'cancelled';
        step.detail = `因前序步骤失败而跳过：${originalFailure}`;
      }
    }
    state.updatedAt = timestamp();

    await CancellationScope.nonCancellable(compensate);
    // 只抛可序列化且不可重试的业务失败，避免普通 Error 导致 Workflow Task 反复失败。
    throw ApplicationFailure.create({
      message: `订单工作流失败：${originalFailure}`,
      type: 'OrderWorkflowFailed',
      nonRetryable: true,
      cause: error instanceof Error ? error : undefined,
      details: [{ workflowId, compensation: state.compensation }],
    });
  }
}
