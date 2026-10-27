export interface SelfCheckQuestion {
  id: string;
  stage: string;
  title: string;
  question: string;
  action: string;
  evidence: string[];
  checkpoints: string[];
  explanation: string;
}

export const SELF_CHECK_QUESTIONS: readonly SelfCheckQuestion[] = [
  {
    id: 'roles', stage: '阶段一 · 角色与正常执行', title: '谁在执行订单？',
    question: '创建请求已经返回，浏览器随后关闭。订单还能继续吗？分别说明 API、Server、Worker、Workflow 和 Activity 的职责。',
    action: '运行正常订单，用默认 Signal 确认，再回看同一 Run 的事件。',
    evidence: ['记录 Workflow ID / Run ID，以及库存、付款、Signal、发货、Workflow 完成事件的 #ID。', '同时记录 Query 的业务状态与 Describe 的执行状态。'],
    checkpoints: ['Server 保存 History 并调度任务；Worker 运行 Workflow 和 Activity。', 'Workflow 编排下一步，Activity 执行普通 Node 业务函数；API 启动执行并返回标识。', '创建成功不等于发货，WorkflowTaskCompleted 不等于 WorkflowExecutionCompleted。'],
    explanation: '关闭浏览器只会停止页面观察。Server 中的执行仍在，Worker 可继续处理；需要人工确认时仍需发送消息。整个订单的完成要由发货结果和 Workflow 执行终态共同说明。',
  },
  {
    id: 'replay', stage: '阶段二 · 恢复与重放', title: '变量怎样回来？',
    question: '付款已完成并记入历史后，Worker 内存全部丢失。新进程如何恢复 paymentCharged 等变量？为什么不必重新执行已完成的付款？',
    action: '按原 Worker 恢复向导完成“等待确认时重启”，先保存基线和停机 History 边界。',
    evidence: ['同一 Run 的基线、Query 中断、边界之后的停机 Signal、后续 Workflow Task 与最终状态。', '基线后的库存 / 付款调度没有新增，账本调用与扣款次数没有增加。'],
    checkpoints: ['Server 提供持久化 History，SDK 重放确定性的编排以重建局部变量。', '已记录成功的 Activity 复用历史结果；Server 不搬运原进程的 JavaScript 堆。', '运行中的 Worker 有缓存，不一定每个任务都从入口重放；Query 不可用不能单独证明进程停机。'],
    explanation: '恢复同一执行依赖历史和确定性的代码路径。单看最后完成不足以证明停机恢复，必须保留停机窗口及同 Run 的前后证据。未确认成功的 Activity 仍可能再次执行。',
  },
  {
    id: 'retry', stage: '阶段三 · 重试、超时与幂等', title: '重试会从库存重来吗？',
    question: '付款前两次失败、第三次成功。Workflow 的 await 在等待什么？是否应当看到三套 Started / Failed 事件，以及三次库存预留？',
    action: '创建自动重试订单，付款成功后确认完成。',
    evidence: ['最终付款 Activity 的 attempt、库存调度记录，以及付款账本的 attempt / failure / debit。', '若在运行中观察，记录 Pending Activity 的 attempt 和 lastFailure。'],
    checkpoints: ['重试策略控制同一个 Activity 的多次尝试，maximumAttempts 包含第一次。', 'await 等待 Activity 最终结果；耗尽后失败才传回 Workflow 的 catch。', '中间失败可能被 History 聚合，不要求三组事件，也不据此推断实际扣款次数。'],
    explanation: '已成功的库存步骤不会因为付款 Activity 重试而整段重跑。History、Pending Activities 和账本分别回答调度、当前尝试和业务效果的问题。',
  },
  {
    id: 'uncertain-effect', stage: '阶段三 · 重试、超时与幂等', title: '成功返回之前已经扣款',
    question: '支付账本已经提交，Activity 却在报告成功前失败。下一次尝试怎样避免再次扣款？如果此时取消，能否只在 paymentCharged 为 true 时退款？',
    action: '运行支付幂等订单，对照付款源码和账本；阅读未知结果时的补偿条件。',
    evidence: ['attempts 为 2、debitCount 为 1，记录真实 debit 与 reused 流水 ID。', '定位稳定幂等键、唯一约束和事务；区分账本 ID 与 History #ID。'],
    checkpoints: ['使用跨尝试稳定的业务键，不能把 attempt 当成幂等键。', 'Temporal History 与外部账本不共享原子事务，外部效果成功不代表成功结果已写入历史。', '已尝试但结果未知也应查账清理；不能只依赖本地“已成功”变量。'],
    explanation: '单笔扣款来自业务系统的幂等机制。重试会真实再次调用 Activity，查账退款也应允许重复调用。这些机制不提供跨系统事务或外部副作用精确执行一次的保证。',
  },
  {
    id: 'timer', stage: '阶段三 · 重试、超时与幂等', title: '两个截止时间',
    question: '详情 HTTP 请求超时与 condition 的确认期限有什么区别？Worker 停止时确认 Timer 是否继续计时，超时补偿又由谁执行？',
    action: '运行等待超时场景，不确认；在“源码与证据”中选择 Timer 主题。',
    evidence: ['approvalDeadline、关联确认等待的 TimerStarted / TimerFired，以及补偿 Activity 与最终 FAILED。', '引用 server/client.ts 的请求截止和 Workflow 的 condition，说明各自范围。'],
    checkpoints: ['HTTP 截止只限制这次请求等待，不会终止长期 Workflow。', '持久化 Timer 在 Server 继续计时，分支代码与补偿仍需 Worker 执行。', '任意 TimerFired 不足以证明确认超时，需要关联等待分支和后续结果。'],
    explanation: '请求没有拿到结果和业务等待到期是两件事。Worker 恢复后可能执行已经到期的超时分支；不能假设停机让确认期限暂停。',
  },
  {
    id: 'cleanup', stage: '阶段四 · 取消、补偿与心跳', title: '已取消但还在运行',
    question: 'Query 已显示 cancelled，Describe 仍是 RUNNING，是否说明 Temporal 出错？取消回执能否证明退款和库存释放都完成？',
    action: '在付款完成后取消一条订单，观察补偿进度直到执行终态。',
    evidence: ['取消请求、各补偿 Activity、compensationProgress 每项状态与账本 refund。', '最终 WorkflowExecutionCanceled 和 Describe CANCELLED；若清理失败，保留失败事实。'],
    checkpoints: ['业务状态和 Temporal 执行终态可以在不同时间改变。', '应用显式安排补偿，并在不可取消作用域中完成清理；取消是协作式的。', '退款检查成功可能没有实际退款；一项补偿失败也不能阻止其他清理被尝试。'],
    explanation: '“请求取消”“业务标记取消”“外部清理完成”“执行终态”需要分别观察。Temporal 不会自动回滚已经发生的外部业务效果。',
  },
  {
    id: 'heartbeat', stage: '阶段四 · 取消、补偿与心跳', title: '这个心跳属于哪次尝试？',
    question: 'Pending Activity 的 attempt 已是 2，但 heartbeat.attempt 仍是 1。能否据此说第二次尝试从该检查点恢复？每一批都应有 History 事件吗？',
    action: '运行心跳超时恢复，记录运行中和完成后的检查点；进程崩溃实验继续使用原恢复向导。',
    evidence: ['记录 Pending state、attempt、heartbeat.attempt、completedBatches、resumedFrom、lastHeartbeatAt。', '完成后记录新鲜 Query 的 state.packing，与 packOrder 完成事件对照。'],
    checkpoints: ['当前尝试的可靠进度需要 attempt 匹配，并确认 Activity 已开始或正在取消。', 'Heartbeat 是 Describe 的最近检查点，不是逐批 History，也不是退出瞬间的内存快照。', 'Activity 新尝试读取 heartbeatDetails 与 Workflow 重放重建变量是不同机制；尾部批次可能重做。'],
    explanation: '旧尝试心跳可以暂时附着在新 Pending attempt 上。缺少匹配证据时应保留未知，不能用旧 Query 补齐，更不能只凭 resumedFrom 证明 Worker 进程曾崩溃。',
  },
  {
    id: 'messages', stage: '阶段五 · Signal / Update', title: '收件、接受与完成',
    question: 'Signal 回执、Update Accepted、Update Completed、handler 返回 approved 和 Workflow 完成分别说明什么？Query 能否代替确认？',
    action: '分别用 Signal 和 Update 确认新订单；Update 先做未勾选的 validator 拒绝实验。',
    evidence: ['记录真实请求回执、Query approvedAt / approvalMethod，以及对应 Signal 或同 ID 的 Update 事件。', '区分 validator 拒绝回执、Completed 的 outcome、发货和 Workflow 最终事件。'],
    checkpoints: ['Signal 收件只表示 Server 保存消息，业务 handler 可以忽略不合条件的确认。', 'validator 拒绝通常没有 Accepted / Completed；Completed 的 outcome 也可能失败。', 'handler approved 表示人工确认完成，后续发货另查；Query 只读，不执行确认。'],
    explanation: '消息的持久化、业务处理和整个订单的结果是不同层面的事实。页面保留的真实回执和历史 outcome 要一起读，事件名字不能替代业务结果。',
  },
  {
    id: 'unknown-update', stage: '阶段五 · Signal / Update', title: '没有拿到结果怎么办？',
    question: 'Update 请求返回 unknown。能否断言没有生效并换一个 Update ID 重发？已被 validator 拒绝的 ID，是否必定可查询到持久化拒绝结果？',
    action: '阅读确认对照中的未知结果恢复；只有实际遇到 unknown 时才用原请求继续，不必人为停止服务。',
    evidence: ['记录原 Workflow ID、Run ID、Update ID 和参数，以及真实回执与后续查询结果。', '按相同 Run / Update ID 查 History；无记录或查询失败时说明仍缺什么。'],
    checkpoints: ['unknown 表示当前请求未拿到确定结果，不能推出未执行或已取消。', '保留原 Run / Update ID 和参数查询或重试；去重与结果保留有服务端范围。', 'validator 拒绝不应被当作必定持久化且可反复查询的结果，同 ID 也不替代支付幂等。'],
    explanation: '先恢复对原请求结果的认识，再决定后续动作。记录中应允许“暂时未知”，不能为完成实验补造 Accepted、Completed 或成功回执。',
  },
  {
    id: 'evidence', stage: '综合 · 证据边界与迁移', title: '这份记录能证明什么？',
    question: 'Query 刷新失败后仍显示 waiting_approval，账本按 Workflow ID 汇总，History 又晚于 Describe 读取。如何说明证据边界，并迁移到资料审核流程？',
    action: '写一份实验记录，再独立设计资料审核练习：准备资料 → 等 Signal 或超时 → 归档 / 清理。',
    evidence: ['分别注明来源、读取时间、Run 范围和新鲜度；区分手工操作时间与服务端事件事实。', '为资料准备设计稳定幂等键、结果未知时的查账清理，以及正常 / 恢复 / 超时 / 取消验收。'],
    checkpoints: ['旧 Query 只表示上次观察；整次详情失败时，保留的所有来源都已过期。', '同次响应也不是跨系统原子快照；Workflow ID 账本不能冒充 Run 专属数据。', '迁移时先定义角色、失败边界和证据，不靠替换业务名复制最终成功页面。'],
    explanation: '合格的解释既说明已观察到的事实，也指出尚不能确认的部分。迁移练习使用独立 Workflow、Task Queue 和模拟业务存储，用同样的证据方法验证设计。',
  },
];

export interface ExperimentNote {
  topic: string;
  prediction: string;
  workflowId: string;
  runId: string;
  observedAt: string;
  actions: string;
  evidence: string;
  explanation: string;
  limits: string;
}

export const EMPTY_EXPERIMENT_NOTE: ExperimentNote = {
  topic: '', prediction: '', workflowId: '', runId: '', observedAt: '',
  actions: '', evidence: '', explanation: '', limits: '',
};

export function learningNotesMarkdown(answers: Record<string, string>, note: ExperimentNote): string {
  const value = (text: string) => text.trim() || '（尚未填写）';
  return [
    '# Temporal 学习笔记',
    '',
    '本文件是学习者手工记录；未自动读取运行数据，也未自动评定通过。',
    '',
    '## 自测作答',
    ...SELF_CHECK_QUESTIONS.flatMap((question, index) => [
      '', `### ${index + 1}. ${question.title}`, '', question.question, '', value(answers[question.id] ?? ''),
    ]),
    '', '## 实验记录',
    ...([
      ['主题 / 场景', note.topic], ['操作前预测', note.prediction],
      ['Workflow ID', note.workflowId], ['Run ID', note.runId], ['观测时间与时区', note.observedAt],
      ['实际操作与时间', note.actions], ['来源、事件 ID 与观测值', note.evidence],
      ['用机制解释差异', note.explanation], ['缺失证据与结论边界', note.limits],
    ] as const).flatMap(([label, text]) => ['', `### ${label}`, '', value(text)]),
    '',
  ].join('\n');
}
