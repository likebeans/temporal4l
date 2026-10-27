export const TASK_QUEUE = 'temporal-learning-orders';
export const WORKFLOW_TYPE = 'orderWorkflow';
export const STATE_QUERY = 'orderState';
export const APPROVE_SIGNAL = 'approveOrder';
export const APPROVE_UPDATE = 'approveOrderUpdate';
export const WORKFLOW_ID_PREFIX = 'learning-order-';

export const PRODUCTS = [
  { id: 'keyboard', name: '机械键盘', price: 299, description: '让每次输入都有回应' },
  { id: 'headphones', name: '无线耳机', price: 499, description: '专注此刻，屏蔽喧嚣' },
  { id: 'coffee', name: '精品咖啡豆', price: 89, description: '为下一次灵感充电' },
] as const;

export type ProductId = (typeof PRODUCTS)[number]['id'];
export type Scenario = 'normal' | 'retry' | 'failure' | 'timeout' | 'idempotency' | 'heartbeat' | 'heartbeat_timeout';
export type OrderStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type StepId = 'inventory' | 'payment' | 'approval' | 'packing' | 'shipping';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface OrderInput {
  customerName: string;
  productId: ProductId;
  quantity: number;
  scenario: Scenario;
  approvalTimeoutSeconds: number;
}

export interface OrderStep {
  id: StepId;
  label: string;
  kind: 'Activity' | 'Signal' | 'Update' | 'Signal / Update';
  status: StepStatus;
  detail: string;
}

export interface ApprovalUpdateInput {
  confirmed: boolean;
}

export interface ApprovalUpdateRequest extends ApprovalUpdateInput {
  runId: string;
  updateId: string;
}

export interface ApprovalUpdateResult {
  workflowId: string;
  runId: string;
  updateId: string;
  approvedAt: string;
  status: 'approved';
}

export interface ApprovalSignalResponse {
  workflowId: string;
  runId: string;
  status: 'sent';
  message: string;
}

export interface CompensationStep {
  id: 'refund' | 'inventory';
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  detail?: string;
}

export interface CompensationProgress {
  status: 'idle' | 'running' | 'completed' | 'failed';
  steps: CompensationStep[];
}

export interface PackingCheckpoint {
  completedBatches: number;
  totalBatches: number;
  attempt: number;
  resumedFrom: number;
  phase: 'packing' | 'paused' | 'completed';
  updatedAt: string;
}

export interface PendingActivity {
  activityId: string;
  activityType: string;
  state: string;
  attempt: number;
  lastHeartbeatAt?: string;
  heartbeat?: PackingCheckpoint;
  lastFailure?: string;
}

export interface PaymentEntry {
  id: number;
  kind: 'attempt' | 'debit' | 'reused' | 'failure' | 'refund';
  attempt: number;
  amount: number;
  message: string;
  createdAt: string;
}

export interface PaymentLedger {
  idempotencyKey: string;
  attempts: number;
  debitCount: number;
  refundCount: number;
  totalCharged: number;
  totalRefunded: number;
  entries: PaymentEntry[];
}

export interface OrderState {
  workflowId: string;
  input: OrderInput;
  status: OrderStatus;
  steps: OrderStep[];
  total: number;
  createdAt: string;
  updatedAt: string;
  approvalDeadline?: string;
  approvedAt?: string;
  approvalMethod?: 'signal' | 'update';
  approvalUpdateId?: string;
  trackingNumber?: string;
  error?: string;
  compensation?: string;
  compensationProgress?: CompensationProgress;
  packing?: PackingCheckpoint;
}

export interface OrderSummary {
  workflowId: string;
  runId: string;
  status: string;
  startedAt: string;
  closedAt?: string;
}

export interface HistoryEvent {
  id: string;
  type: string;
  timestamp: string;
  label: string;
  detail?: string;
  activityType?: string;
  attempt?: number;
  signalName?: string;
  updateId?: string;
  updateName?: string;
  category: 'workflow' | 'activity' | 'signal' | 'update' | 'timer' | 'other';
}

export interface OrderDetail {
  workflowId: string;
  runId: string;
  status: string;
  state: OrderState | null;
  stateError?: string;
  history: HistoryEvent[];
  observedAt: string;
  pendingActivities: PendingActivity[];
  payment: PaymentLedger;
}

export interface HealthResponse {
  temporal: boolean;
  worker: boolean;
  namespace: string;
  taskQueue: string;
  temporalUiUrl: string;
  message?: string;
}

export interface CreateOrderResponse {
  workflowId: string;
  runId: string;
}

export const SCENARIOS: { id: Scenario; label: string; description: string }[] = [
  { id: 'normal', label: '正常处理', description: '付款成功，等待你的确认后发货。' },
  { id: 'retry', label: '自动重试', description: '前两次付款故意失败，第 3 次自动成功。' },
  { id: 'failure', label: '失败与补偿', description: '付款持续失败，3 次尝试后释放库存。' },
  { id: 'timeout', label: '等待超时', description: '15 秒内未确认，自动退款并释放库存。' },
  { id: 'idempotency', label: '支付幂等', description: '扣款入账后故意失败，重试复用同一笔扣款。' },
  { id: 'heartbeat', label: '长任务心跳', description: '确认后分批打包；观察心跳进度，运行中可取消。' },
  { id: 'heartbeat_timeout', label: '心跳超时恢复', description: '打包中停止心跳，超时重试从检查点继续。' },
];
