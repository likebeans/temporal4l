export interface WalkthroughStep {
  title: string;
  server: string;
  worker: string;
  effect: string;
  explanation: string;
}

export interface Walkthrough {
  id: string;
  title: string;
  question: string;
  steps: WalkthroughStep[];
  verify: string;
}

// 手工编写的教学步骤，不是 Temporal History、实时状态或实验结果。
export const WALKTHROUGHS: Walkthrough[] = [
  {
    id: 'normal',
    title: '正常订单',
    question: '点击创建订单之后，谁在执行代码？等待确认时又是谁在保存进度？',
    steps: [
      { title: 'Client 发起执行', server: '接受启动请求，保存执行历史，调度 Workflow Task。', worker: '从 Task Queue 领取任务，运行订单编排。', effect: '此时还没有完成付款。', explanation: '启动请求返回 Workflow ID，表示执行已创建，不表示订单完成。Server 负责保存与调度，Worker 负责执行代码。' },
      { title: 'Activity 执行业务', server: '记录库存与付款 Activity 的调度和成功结果。', worker: '执行预留库存、付款 Activity；编排等待这些结果。', effect: '模拟支付账本记录一次扣款。', explanation: '外部 I/O 放在 Activity。History 保存的成功结果让后续重放能继续编排，但不能替外部系统提供业务幂等。' },
      { title: '等待人工确认', server: '保存 Timer，等待消息；执行状态仍是 RUNNING。', worker: '编排通过 condition 等待确认，不需要一直占用线程。', effect: '已经扣款，尚未发货。', explanation: 'Workflow 可以在 Worker 缓存中；即使进程消失，Server 中的 History 和 Timer 仍保留。' },
      { title: 'Signal 到达', server: '持久化 Signal，并调度后续 Workflow Task。', worker: '收到任务后执行 handler，更新确认状态，让等待条件成立。', effect: '收到 Signal 的回执本身还不能证明已发货。', explanation: 'Signal 的发送成功说明 Server 已收件。handler 是否接受、业务是否推进，需用后续 Query、History 和结果核对。' },
      { title: '发货并完成', server: '保存发货 Activity 结果和 Workflow 完成事件。', worker: '执行发货 Activity，编排返回最终结果。', effect: '模拟发货单已创建，最终执行状态 COMPLETED。', explanation: '业务状态、执行状态和外部账本来自不同来源，读取也不是原子快照。需要结合它们解释实际发生了什么。' },
    ],
    verify: '本地选择“正常处理”，用默认 Signal 确认。核对同一个 Run 的库存、付款、Timer、Signal、发货和完成事件。',
  },
  {
    id: 'recovery',
    title: 'Worker 停止与恢复',
    question: 'Worker 失去内存后，为什么已成功的付款可以不再执行？',
    steps: [
      { title: '先保存基线', server: '已记录付款成功，执行正在等待确认。', worker: 'Query 返回 waiting_approval；保存同一个 Workflow ID / Run ID。', effect: '账本中已有一次扣款。', explanation: '恢复实验先建立基线。仅看“重启后成功”无法证明停机期间发生了什么，也无法证明同一执行恢复。' },
      { title: '停止唯一 Worker', server: 'History 与 Timer 继续存在；Timer 不因 Worker 停机暂停。', worker: '进程已停止，Query 无法由这个 Worker 处理。', effect: '没有 Worker 执行业务代码。', explanation: '实际实验需要确认任务队列上没有其他 Worker，并记录 Query 中断与 History 边界。健康指示可能滞后。' },
      { title: '停机期间发送 Signal', server: '在确认超时之前收到 Signal，将它持久化在 History 中。', worker: '尚未处理 handler；业务不能仅凭 Signal 回执判定已确认。', effect: '尚未发货。', explanation: '本示意假定 Signal 在审核 Timer 到期前到达。真实环境中的先后顺序必须从同一 Run 的历史确认。' },
      { title: '以兼容代码重启', server: '向新 Worker 提供已有 History 和待处理任务。', worker: '重放确定性编排，重建变量；使用已记录的成功 Activity 结果，再处理消息。', effect: '已确认成功的付款不因重放再次调用。', explanation: '重放不是恢复旧 JavaScript 堆。没有成功记录的 Activity 可能重试；运行中的 Worker 也不一定每轮都从入口完整重放。' },
      { title: '核对恢复结果', server: '同一个 Run 记录后续发货和完成。', worker: '编排推进并结束。', effect: '账本付款调用和扣款数都应与基线对照。', explanation: '同 Run、停机边界、Signal 入库、后续任务以及账本变化共同构成证据。页面上的步骤演示不等于完成了真实恢复实验。' },
    ],
    verify: '按本地“Worker 恢复实验”向导，先核对唯一 Worker，再记录停机边界、停机 Signal 与同 Run 恢复。',
  },
  {
    id: 'idempotency',
    title: '响应丢失与幂等',
    question: '付款已经入账，但成功响应丢失，Temporal 下一次重试会怎样？',
    steps: [
      { title: '第一次付款调用', server: '调度付款 Activity。', worker: '使用稳定键 workflowId:charge 调用模拟付款。', effect: 'SQLite 事务提交一笔扣款。', explanation: '外部效果与 Temporal 的 History 之间没有跨系统原子事务。入账成功和结果被 Server 记录是两件事。' },
      { title: '提交后响应丢失', server: '尚未记录付款 Activity 成功，按重试策略安排下一次尝试。', worker: '第一次调用在入账后抛出模拟错误。', effect: '扣款已存在，但 Workflow 不知道结果。', explanation: '这就是结果未知的窗口。不能将“没有看到成功”推断成“没有产生外部效果”。' },
      { title: '第二次尝试', server: 'Activity attempt 增加；中间重试历史可能被合并。', worker: '再次使用同一个业务幂等键。', effect: '账本复用已有付款结果，不再扣第二笔。', explanation: 'attempt 或 Run ID 不应取代稳定业务幂等键。是否重复扣款由外部存储的唯一约束与事务保障。' },
      { title: '成功结果进入历史', server: '记录付款 Activity 成功，编排进入等待确认。', worker: '把复用的付款结果返回给编排。', effect: '本示例最终为付款调用 2 次、实际扣款 1 次。', explanation: 'History 的 Activity 事件数量不能当成真实调用或扣款次数。用 Activity attempt 和独立账本分别核对。' },
    ],
    verify: '本地选择“支付幂等”，核对 attempt、付款调用次数、实际扣款和账本复用记录，再确认订单完成。',
  },
];
