import { PRODUCTS, SCENARIOS, WORKFLOW_ID_PREFIX, type OrderInput } from '../shared/types';

export const createOrderSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['customerName', 'productId', 'quantity', 'scenario', 'approvalTimeoutSeconds'],
  properties: {
    customerName: { type: 'string', minLength: 1, maxLength: 40, pattern: '\\S' },
    productId: { type: 'string', enum: PRODUCTS.map((product) => product.id) },
    quantity: { type: 'integer', minimum: 1, maximum: 10 },
    scenario: { type: 'string', enum: SCENARIOS.map((scenario) => scenario.id) },
    approvalTimeoutSeconds: { type: 'integer', minimum: 5, maximum: 600 },
  },
} as const;

export function normalizeOrder(input: OrderInput): OrderInput {
  return {
    ...input,
    customerName: input.customerName.trim(),
    approvalTimeoutSeconds: input.scenario === 'timeout' ? 15 : input.approvalTimeoutSeconds,
  };
}

// 演示 API 只操作自己创建的订单，避免影响同一 Temporal 服务上的其他工作流。
export function isDemoWorkflowId(value: string): boolean {
  return new RegExp(`^${WORKFLOW_ID_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i').test(value);
}
