import { Activity, ArrowDown, BookOpen, ChevronDown, RefreshCw, Server, Workflow } from 'lucide-react';

interface LearningGuideProps {
  open: boolean;
  onToggle: () => void;
}

const concepts = [
  {
    title: 'Temporal Server',
    icon: Server,
    text: '保存事件历史，调度任务和持久化 Timer；业务代码由 Worker 执行。',
  },
  {
    title: 'Worker',
    icon: RefreshCw,
    text: '从 Task Queue 领取任务，运行 Workflow 和 Activity。停止进程不会删除 Server 中的历史。',
  },
  {
    title: 'Workflow',
    icon: Workflow,
    text: '确定性编排业务步骤和等待。Worker 丢失内存后，通过重放历史重建变量和执行状态。',
  },
  {
    title: 'Activity',
    icon: Activity,
    text: '在普通 Node 环境执行付款等外部操作。结果未被确认时可能再次执行，需要业务幂等。',
  },
];

const stages = [
  {
    title: '正常订单与角色分工',
    goal: '解释浏览器、API、Temporal Server 和 Worker 分别负责什么。',
    action: '创建“正常处理”订单，等待人工确认后使用默认 Signal，再观察发货完成。',
    evidence: '对照 Query 业务状态、Temporal 执行状态和 History，找到库存、付款、Signal 与发货事件。',
  },
  {
    title: '停止 Worker，理解恢复',
    goal: '解释历史保存在哪里、变量如何重建，以及已完成的付款为何不因重放再次执行。',
    action: '展开下方“Worker 恢复实验”，先按说明独立运行 Worker，再完成“等待确认时重启”。',
    evidence: '核对同一个 Run、Query 中断与恢复、停机期间 Signal 入库，以及付款次数保持不变。',
  },
  {
    title: '重试、超时与幂等',
    goal: '区分 Activity 的真实重试、Workflow 重放和等待确认的持久化 Timer。',
    action: '依次体验“自动重试”“等待超时”“支付幂等”，每次创建一条新订单。',
    evidence: '付款第 3 次尝试成功；确认超时出现 TimerFired；支付幂等场景尝试 2 次、扣款 1 次。',
  },
  {
    title: '取消、补偿与心跳',
    goal: '解释取消为何需要等待补偿，以及长 Activity 如何从服务端检查点继续。',
    action: '在“长任务心跳”打包期间取消，再体验“心跳超时恢复”；最后尝试打包期间崩溃实验。',
    evidence: '观察逐项退款与释放库存、最终 CANCELLED，以及新 Activity 尝试的 attempt 和 resumedFrom。',
  },
  {
    title: 'Signal / Update 深入对照',
    goal: '区分 Server 收件、handler 业务结果和整个 Workflow 完成。',
    action: '创建两条正常订单分别使用 Signal 和 Update；Update 先做校验拒绝实验，再勾选确认。',
    evidence: '对照 Signal 回执、Update 返回值和 Accepted / Completed 事件，再学习原 ID 查询与重试。',
  },
];

export function LearningGuide({ open, onToggle }: LearningGuideProps) {
  return (
    <section className="learning-guide" id="learning-guide" aria-labelledby="learning-guide-title">
      <div className="learning-guide__header">
        <div>
          <p className="eyebrow eyebrow--on-tint">从第一条订单开始</p>
          <h2 id="learning-guide-title">分五步理解 Temporal</h2>
          <p>先跑正常流程，再停 Worker 看恢复，随后逐步加入故障、心跳和消息对照。</p>
        </div>
        <button
          className="learning-guide__toggle"
          type="button"
          aria-expanded={open}
          aria-controls="learning-guide-body"
          onClick={onToggle}
        >
          <BookOpen size={16} aria-hidden="true" />
          {open ? '收起学习路线' : '展开学习路线'}
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>

      <div id="learning-guide-body" hidden={!open} className="learning-guide__body">
        <section className="learning-model" aria-labelledby="learning-model-title">
          <h3 id="learning-model-title">Server 保存历史，Worker 重放代码</h3>
          <p>
            Workflow 的恢复依据是事件历史。Worker 丢失内存后，SDK 重放确定性的编排代码，重建变量和等待；
            已记录成功的 Activity 使用历史结果。未被确认的 Activity 仍可能重试，外部副作用需要幂等。
          </p>
          <p>运行中的 Worker 可以缓存状态，不必每次任务都从头完整重放。停止 Worker 后，Server 上的 Timer 仍会计时，业务代码等待 Worker 恢复后执行。</p>
        </section>

        <div className="concept-grid">
          {concepts.map(({ title, icon: Icon, text }) => (
            <article className="concept-card" key={title}>
              <span className="concept-card__icon" aria-hidden="true"><Icon size={18} /></span>
              <div><h3>{title}</h3><p>{text}</p></div>
            </article>
          ))}
        </div>

        <ol className="learning-path" aria-label="建议学习顺序">
          {stages.map((stage, index) => (
            <li key={stage.title}>
              <details open={index === 0}>
                <summary>
                  <span className="learning-path__number" aria-hidden="true">0{index + 1}</span>
                  <span>{stage.title}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </summary>
                <dl>
                  <div><dt>学习目标</dt><dd>{stage.goal}</dd></div>
                  <div><dt>动手操作</dt><dd>{stage.action}</dd></div>
                  <div><dt>观察证据</dt><dd>{stage.evidence}</dd></div>
                </dl>
              </details>
            </li>
          ))}
        </ol>
      </div>

      <a className="learning-guide__start" href="#create-order-title">
        <ArrowDown size={16} aria-hidden="true" />
        前往创建订单 · 第一课选择“正常处理”，使用默认 Signal 确认
      </a>
      <a className="learning-guide__start" href="#learning-practice">
        <BookOpen size={16} aria-hidden="true" />
        学完后：自测、记录证据与迁移练习
      </a>
    </section>
  );
}
