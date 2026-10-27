import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isDemoWorkflowId, normalizeOrder } from '../server/validation';
import { WORKFLOW_ID_PREFIX, type OrderInput } from '../shared/types';

const input: OrderInput = {
  customerName: '  示例用户  ', productId: 'coffee', quantity: 2,
  scenario: 'normal', approvalTimeoutSeconds: 120,
};

test('普通场景保留确认期限并清理姓名首尾空白', () => {
  assert.deepEqual(normalizeOrder(input), { ...input, customerName: '示例用户' });
  assert.equal(input.customerName, '  示例用户  ');
});

test('超时场景固定 15 秒，防止表单修改导致演示行为不一致', () => {
  assert.equal(normalizeOrder({ ...input, scenario: 'timeout', approvalTimeoutSeconds: 600 }).approvalTimeoutSeconds, 15);
});

test('API 仅接受带本示例前缀的 UUID 工作流', () => {
  assert.equal(isDemoWorkflowId(`${WORKFLOW_ID_PREFIX}${randomUUID()}`), true);
  for (const value of ['other-workflow', `${WORKFLOW_ID_PREFIX}other`, `${WORKFLOW_ID_PREFIX}${randomUUID()}/cancel`, "' OR 1=1"]) {
    assert.equal(isDemoWorkflowId(value), false, value);
  }
});
