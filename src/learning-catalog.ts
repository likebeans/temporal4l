export type LearningTopicId = 'execution' | 'recovery' | 'retry' | 'timer' | 'idempotency' | 'cancellation' | 'heartbeat' | 'signal' | 'update';
export type LearningSourcePath = 'server/index.ts' | 'server/worker.ts' | 'server/workflows.ts' | 'server/activities.ts' | 'server/payment-ledger.ts' | 'src/recovery.ts';

export interface SourceReference {
  file: LearningSourcePath;
  symbol: string;
  from: string;
  until?: string;
}

export interface LearningTopic {
  id: LearningTopicId;
  title: string;
  question: string;
  action: string;
  explanation: string;
  boundary: string;
  sources: SourceReference[];
}

const workflowMain: SourceReference = {
  file: 'server/workflows.ts', symbol: 'orderWorkflow · 编排主干',
  from: "    updateStep('inventory', 'running'", until: '  } catch (error) {',
};
const worker: SourceReference = {
  file: 'server/worker.ts', symbol: 'main · Worker 注册与运行',
  from: '    const worker = await Worker.create({', until: '  } finally {',
};
const charge: SourceReference = {
  file: 'server/activities.ts', symbol: 'chargePayment · 故障注入与扣款',
  from: 'export async function chargePayment(', until: 'export async function packOrder(',
};
const compensate: SourceReference = {
  file: 'server/workflows.ts', symbol: 'compensate · 逐项清理',
  from: '  const compensate = async', until: '\n  try {',
};

export const LEARNING_TOPICS: LearningTopic[] = [
  {
    id: 'execution', title: '正常执行与角色分工',
    question: '一次 HTTP 请求如何变成长期运行的订单？',
    action: '创建正常订单，等付款成功后发送默认 Signal，再观察发货和执行完成。',
    explanation: 'API 启动执行并返回 ID；Worker 从 Task Queue 领取任务。Workflow 的 await 安排 Activity 和持久化等待，Activity 函数体执行具体操作。',
    boundary: 'WorkflowTaskCompleted 只表示一轮编排任务已提交。订单完成需要 WorkflowExecutionCompleted；Query 与 Describe 也可能在完成边界暂时不同步。',
    sources: [
      { file: 'server/index.ts', symbol: 'POST /api/orders · workflow.start', from: "app.post<{ Body: OrderInput }>('/api/orders'", until: '\nconst uuidSchema' },
      worker, workflowMain,
      { file: 'server/activities.ts', symbol: 'reserveInventory · 普通 Node 函数', from: 'export async function reserveInventory(', until: 'export async function chargePayment(' },
    ],
  },
  {
    id: 'recovery', title: 'Worker 恢复与历史重放',
    question: '进程内存丢失后，变量和已完成的步骤如何恢复？',
    action: '使用已有 Worker 恢复向导，保存基线、停止独立 Worker，认证停机窗口内的 Signal 后重启。',
    explanation: 'Server 保留历史；新 Worker 重放确定性编排，重建局部变量。已记录成功的 Activity 使用历史结果，未确认完成的 Activity 仍可能真实重试。',
    boundary: '单次快照无法证明进程停止或恢复，Query 不可用也不能单独证明停机。请在恢复向导核对同一 Run、基线、阶段、History 边界及付款次数；这里不重新判定恢复成功。',
    sources: [worker, workflowMain,
      { file: 'src/recovery.ts', symbol: 'recoveryPhaseReadiness · 恢复阶段门禁', from: 'export function recoveryPhaseReadiness(', until: 'export function transitionRecoveryPhase(' },
    ],
  },
  {
    id: 'retry', title: 'Activity 重试与最终失败',
    question: '付款失败重试时，为什么库存不需要重新执行？',
    action: '体验自动重试，再创建失败与补偿订单，比较最终尝试次数和补偿事件。',
    explanation: 'proxyActivities 的 retry 控制付款 Activity 的下一次尝试。Workflow 中的 await 等待最终结果；达到上限后的失败才进入 catch 和补偿。',
    boundary: '中间重试可能被 History 聚合，不要求逐次出现 Started / Failed。Pending Activity 的 attempt 是调度信息，支付调用与扣款数量以独立账本为准。',
    sources: [
      { file: 'server/workflows.ts', symbol: 'chargePayment · 重试策略', from: 'const { chargePayment } = proxyActivities', until: 'const { packOrder } = proxyActivities' },
      charge, compensate,
    ],
  },
  {
    id: 'timer', title: '持久化 Timer 与确认超时',
    question: '确认等待时间和 HTTP 请求截止时间有什么区别？',
    action: '创建等待超时订单，保持不确认，观察 TimerFired、补偿和最终 FAILED。',
    explanation: 'condition 使用业务确认期限创建持久化等待。Worker 停机时 Server 的 Timer 仍计时，超时分支与补偿由恢复后的 Worker 执行。',
    boundary: 'HTTP 请求的等待截止只限制本次请求，不会终止长期 Workflow。TimerFired 说明定时器触发，仍需观察退款、库存释放和执行终态。',
    sources: [
      { file: 'server/workflows.ts', symbol: 'condition · 确认等待与超时分支', from: '    const approvalTimeoutMs =', until: "    state.status = 'running';" },
      { file: 'server/index.ts', symbol: 'GET /api/orders/:workflowId · 观察请求预算', from: "app.get<{ Params: OrderParams }>('/api/orders/:workflowId'", until: "app.post<{ Params: OrderParams }>('/api/orders/:workflowId/approve'" },
      compensate,
    ],
  },
  {
    id: 'idempotency', title: '支付幂等与结果不确定性',
    question: 'Activity 调用两次，为什么账本只扣款一次？',
    action: '创建支付幂等订单，等付款自动重试成功，展开账本对照 attempt、debit 和 reused。',
    explanation: '第一次扣款事务已提交，Activity 报告成功前故意失败。下一次尝试使用稳定幂等键，业务账本复用原付款。',
    boundary: '一次扣款来自业务幂等机制。Temporal History 与 SQLite 没有共享原子事务；账本按 Workflow ID 归集，不能直接当作 Run 专属数据，也不能用 History 事件数量代替扣款次数。',
    sources: [charge,
      { file: 'server/payment-ledger.ts', symbol: 'PaymentStore.charge · 唯一付款与幂等命中', from: '  charge(workflowId:', until: '  refund(workflowId:' },
    ],
  },
  {
    id: 'cancellation', title: '取消、失败与显式补偿',
    question: '业务已显示取消，为什么执行可能仍为 RUNNING？',
    action: '付款完成后取消订单，或让付款重试耗尽。观察 Query 的逐项补偿、补偿 Activity、账本与最终状态。',
    explanation: '应用先更新业务状态，再在不可取消作用域中查账退款和释放库存。每项补偿独立处理失败；补偿由应用显式安排。',
    boundary: '取消请求不等于取消完成；退款 Activity 成功也不一定产生实际退款，未扣款时只是安全查账。用账本核对业务效果，用 History / Describe 核对执行事实。',
    sources: [
      { file: 'server/workflows.ts', symbol: 'catch · 取消作用域与失败处理', from: '    const cancellationScope = CancellationScope.current();', until: '\n  }\n}' },
      compensate,
      { file: 'server/activities.ts', symbol: 'refundPayment / releaseInventory', from: 'export async function refundPayment(' },
    ],
  },
  {
    id: 'heartbeat', title: '心跳检查点与 Activity 新尝试',
    question: '长任务恢复的是哪个检查点，和 Workflow 重放有什么区别？',
    action: '体验心跳超时恢复；需要验证进程崩溃时使用已有打包恢复向导。',
    explanation: 'packOrder 从 heartbeatDetails 读取服务端保存的批次，再上报当前尝试的心跳。Activity 完成后，返回的最终检查点才出现在 Query 的 state.packing。',
    boundary: '新 Pending Activity 可能还带着旧尝试的心跳，attempt 必须匹配。检查点不是进程内存快照，末尾批次可能重做；每次心跳也不会变成一条 History 事件。',
    sources: [
      { file: 'server/activities.ts', symbol: 'packOrder · checkpoint 与超时注入', from: 'export async function packOrder(', until: 'export async function shipOrder(' },
      { file: 'server/workflows.ts', symbol: 'packOrder · 心跳和重试期限', from: 'const { packOrder } = proxyActivities', until: 'function timestamp(' },
    ],
  },
  {
    id: 'signal', title: 'Signal 收件与业务接受',
    question: 'Server 收到消息后，何时才算人工确认完成？',
    action: '等待人工确认时发送 Signal，对照收件回执、History 和 Query 的 approvedAt。',
    explanation: '客户端等待 Server 收件；Worker 执行 handler 后才会修改 approvalReceived。此示例的业务规则会忽略提前或重复确认。',
    boundary: 'WorkflowExecutionSignaled 只说明消息已持久化，不表示业务接受，更不表示发货完成。普通确认 API 先做 Query，停机收信实验按恢复向导使用官方 UI。',
    sources: [
      { file: 'server/index.ts', symbol: 'POST /approve · Signal 回执', from: "app.post<{ Params: OrderParams }>('/api/orders/:workflowId/approve'", until: 'app.post<{ Params: OrderParams; Body: ApprovalUpdateRequest }>' },
      { file: 'server/workflows.ts', symbol: 'applyApproval · 确认业务门禁', from: '  const applyApproval =', until: '  const validateApprovalUpdate =' },
      { file: 'server/workflows.ts', symbol: 'setHandler(approveSignal)', from: '  setHandler(approveSignal,', until: '  setHandler(approveUpdate,' },
    ],
  },
  {
    id: 'update', title: 'Update 校验、结果与请求标识',
    question: 'Accepted、Completed 和 HTTP 返回值分别说明什么？',
    action: '等待确认时选择 Update，先不勾选做拒绝实验，再勾选发送；结果未知时保留原 Run / Update ID 查询或重试。',
    explanation: 'validator 只读校验，handler 再检查并修改状态。用同一个 Update ID 关联请求与 History，handler 的业务返回值和后续发货分别观察。',
    boundary: 'Completed 也可能携带失败 outcome，不能仅凭事件名推断成功。validator 拒绝通常没有 Accepted / Completed，以实际回执为准；unknown 不等于未生效，同 ID 去重限于同 Run 和服务端保留范围。',
    sources: [
      { file: 'server/workflows.ts', symbol: 'validator / Update handler', from: '  const validateApprovalUpdate =', until: '  const activityArgs:' },
      { file: 'server/index.ts', symbol: 'executeUpdate · 成功、拒绝与未知结果', from: 'app.post<{ Params: OrderParams; Body: ApprovalUpdateRequest }>', until: 'app.get<{ Params: OrderParams & { updateId: string }' },
    ],
  },
];
