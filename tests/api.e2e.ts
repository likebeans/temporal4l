import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApprovalSignalResponse, ApprovalUpdateResult, CreateOrderResponse, OrderDetail, OrderInput, OrderStatus } from '../shared/types';

// 此测试驱动真实 API + Worker + Temporal。先用 temporal:local 或 temporal:up 启动 Temporal，再运行 npm run dev。
const base = process.env.DEMO_API_URL || 'http://127.0.0.1:3001';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { message?: string };
  assert.equal(response.ok, true, `${response.status}: ${body.message ?? JSON.stringify(body)}`);
  return body as T;
}

async function start(scenario: OrderInput['scenario'], timeout = 120): Promise<CreateOrderResponse> {
  return request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      customerName: '端到端测试', productId: 'keyboard', quantity: 1,
      scenario, approvalTimeoutSeconds: timeout,
    }),
  });
}

async function waitFor(workflowId: string, status: OrderStatus): Promise<OrderDetail> {
  const deadline = Date.now() + 50_000;
  let latest: OrderDetail | undefined;
  do {
    latest = await request<OrderDetail>(`/api/orders/${workflowId}`);
    if (latest.state?.status === status && (
      !['failed', 'cancelled', 'completed'].includes(status) || latest.status !== 'RUNNING'
    )) return latest;
    await delay(400);
  } while (Date.now() < deadline);
  assert.fail(`等待 ${status} 超时：${JSON.stringify(latest)}`);
}

test('真实 API：正常订单通过 Signal 后完成', { timeout: 60_000 }, async () => {
  const { workflowId } = await start('normal');
  try {
    const waiting = await waitFor(workflowId, 'waiting_approval');
    assert.equal(waiting.state?.total, 299);
    const receipt = await request<ApprovalSignalResponse>(`/api/orders/${workflowId}/approve`, { method: 'POST' });
    assert.equal(receipt.status, 'sent');
    assert.equal(receipt.runId, waiting.runId);
    const completed = await waitFor(workflowId, 'completed');
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.state?.trackingNumber);
    assert.ok(completed.history.some((event) => event.type === 'WorkflowExecutionSignaled'));
    assert.ok(completed.history.some((event) => event.type === 'WorkflowExecutionCompleted'));
    const duplicate = await fetch(`${base}/api/orders/${workflowId}/approve`, { method: 'POST' });
    assert.equal(duplicate.status, 409);
  } finally {
    await fetch(`${base}/api/orders/${workflowId}/cancel`, { method: 'POST' });
  }
});

test('真实 API：Update 校验拒绝、确认结果、同 ID 去重与终态结果查询', { timeout: 60_000 }, async () => {
  const { workflowId, runId } = await start('heartbeat');
  try {
    await waitFor(workflowId, 'waiting_approval');
    const rejectedId = randomUUID();
    const rejected = await fetch(`${base}/api/orders/${workflowId}/approval-updates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, updateId: rejectedId, confirmed: false }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(rejected.status, 409);
    const rejection = await rejected.json() as { status: string; failureType: string; message: string };
    assert.equal(rejection.status, 'rejected');
    assert.equal(rejection.failureType, 'ApprovalConfirmationRequired');
    assert.match(rejection.message, /核对订单/);
    const stillWaiting = await request<OrderDetail>(`/api/orders/${workflowId}`);
    assert.equal(stillWaiting.state?.status, 'waiting_approval');
    assert.equal(stillWaiting.history.some((event) => event.updateId === rejectedId), false);

    const updateId = randomUUID();
    const payload = JSON.stringify({ runId, updateId, confirmed: true });
    const result = await request<ApprovalUpdateResult>(`/api/orders/${workflowId}/approval-updates`, { method: 'POST', body: payload });
    assert.deepEqual({ workflowId: result.workflowId, runId: result.runId, updateId: result.updateId, status: result.status },
      { workflowId, runId, updateId, status: 'approved' });
    assert.ok(result.approvedAt);
    const afterApproval = await request<OrderDetail>(`/api/orders/${workflowId}`);
    assert.equal(afterApproval.status, 'RUNNING', '确认结果先于 12 批打包及发货完成');
    assert.equal(afterApproval.state?.approvalMethod, 'update');
    assert.equal(afterApproval.state?.approvalUpdateId, updateId);

    const duplicate = await request<ApprovalUpdateResult>(`/api/orders/${workflowId}/approval-updates`, { method: 'POST', body: payload });
    assert.deepEqual(duplicate, result);
    const second = await fetch(`${base}/api/orders/${workflowId}/approval-updates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, updateId: randomUUID(), confirmed: true }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(second.status, 409);
    const completed = await waitFor(workflowId, 'completed');
    const queried = await request<ApprovalUpdateResult>(`/api/orders/${workflowId}/approval-updates/${updateId}?runId=${runId}`);
    assert.deepEqual(queried, result);
    assert.equal(completed.history.filter((event) => event.type === 'WorkflowExecutionUpdateAccepted' && event.updateId === updateId).length, 1);
    assert.equal(completed.history.filter((event) => event.type === 'WorkflowExecutionUpdateCompleted' && event.updateId === updateId).length, 1);
    assert.equal(completed.history.filter((event) => event.type === 'ActivityTaskScheduled' && event.activityType === 'shipOrder').length, 1);

    const missing = await fetch(`${base}/api/orders/${workflowId}/approval-updates/${rejectedId}?runId=${runId}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(missing.status, 202);
    assert.equal((await missing.json() as { status: string }).status, 'unknown');
  } finally {
    await fetch(`${base}/api/orders/${workflowId}/cancel`, { method: 'POST' });
  }
});

test('真实 API：Update HTTP 输入校验不替代 Workflow validator', async () => {
  const { workflowId, runId } = await start('normal');
  try {
    for (const body of [
      { runId, updateId: randomUUID(), confirmed: 'true' },
      { runId: 'latest', updateId: randomUUID(), confirmed: true },
      { runId, updateId: 'bad', confirmed: false },
    ]) {
      const response = await fetch(`${base}/api/orders/${workflowId}/approval-updates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await fetch(`${base}/api/orders/${workflowId}/cancel`, { method: 'POST' });
  }
});

test('真实 API：付款重试两次后成功', { timeout: 60_000 }, async () => {
  const { workflowId } = await start('retry');
  try {
    const waiting = await waitFor(workflowId, 'waiting_approval');
    assert.equal(waiting.state?.steps.find((step) => step.id === 'payment')?.status, 'completed');
    const paymentStarted = waiting.history.find((event) => event.type === 'ActivityTaskStarted' && event.detail?.includes('chargePayment'));
    assert.ok(paymentStarted?.detail?.includes('第 3 次尝试'), JSON.stringify(waiting.history));
    await request(`/api/orders/${workflowId}/approve`, { method: 'POST' });
    assert.equal((await waitFor(workflowId, 'completed')).status, 'COMPLETED');
  } finally {
    await fetch(`${base}/api/orders/${workflowId}/cancel`, { method: 'POST' });
  }
});

test('真实 API：付款重试耗尽后释放库存', { timeout: 60_000 }, async () => {
  const { workflowId } = await start('failure');
  const detail = await waitFor(workflowId, 'failed');
  assert.equal(detail.status, 'FAILED');
  assert.ok(detail.state?.compensation?.includes('库存'));
  assert.ok(detail.history.some((event) => event.type === 'ActivityTaskFailed'));
  assert.ok(detail.history.some((event) => event.type === 'ActivityTaskCompleted' && event.detail?.includes('releaseInventory')));
});

test('真实 API：人工确认超时后退款并释放库存', { timeout: 60_000 }, async () => {
  const { workflowId } = await start('timeout');
  const detail = await waitFor(workflowId, 'failed');
  assert.equal(detail.status, 'FAILED');
  assert.ok(detail.history.some((event) => event.type === 'TimerFired'));
  for (const activity of ['refundPayment', 'releaseInventory']) {
    assert.ok(detail.history.some((event) => event.type === 'ActivityTaskCompleted' && event.detail?.includes(activity)));
  }
});

test('真实 API：等待期间取消会补偿并保留 CANCELLED 状态', { timeout: 60_000 }, async () => {
  const { workflowId } = await start('normal');
  await waitFor(workflowId, 'waiting_approval');
  await request(`/api/orders/${workflowId}/cancel`, { method: 'POST' });
  const detail = await waitFor(workflowId, 'cancelled');
  assert.equal(detail.status, 'CANCELLED');
  for (const activity of ['refundPayment', 'releaseInventory']) {
    assert.ok(detail.history.some((event) => event.type === 'ActivityTaskCompleted' && event.detail?.includes(activity)));
  }
});

test('真实 API：非法输入和其他工作流不能进入演示', async () => {
  const invalid = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName: ' ', productId: 'keyboard', quantity: -1 }),
  });
  assert.equal(invalid.status, 400);
  for (const path of ['/api/orders/unrelated', '/api/orders/unrelated/cancel', '/api/orders/unrelated/approve']) {
    const response = await fetch(`${base}${path}`, { method: path.endsWith('unrelated') ? 'GET' : 'POST' });
    assert.equal(response.status, 400);
  }
});
