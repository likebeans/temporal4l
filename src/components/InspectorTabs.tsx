import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Activity, Braces, CircleDot, Clock3, Code2, Info, ListTree, Maximize2, MessageSquareMore, MessageSquareReply, Minimize2, Timer, Workflow } from 'lucide-react';
import type { ComponentType } from 'react';
import type { HistoryEvent, OrderDetail } from '../../shared/types';
import type { ApprovalFeedback } from '../../shared/approval';
import { formatDateTime } from '../format';
import { SourceEvidencePanel } from './SourceEvidencePanel';

type TabId = 'state' | 'history' | 'evidence' | 'code';

interface InspectorTabsProps {
  initialTab?: TabId;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  detail: OrderDetail | null;
  queryFresh?: boolean;
  responseFresh?: boolean;
  feedback?: ApprovalFeedback | null;
}

const tabs: { id: TabId; label: string; icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }> }[] = [
  { id: 'state', label: '状态 JSON', icon: Braces },
  { id: 'history', label: '事件历史', icon: ListTree },
  { id: 'evidence', label: '源码与证据', icon: Workflow },
  { id: 'code', label: '核心代码概念', icon: Code2 },
];

const categoryIcons: Record<HistoryEvent['category'], ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  workflow: Workflow,
  activity: Activity,
  signal: MessageSquareMore,
  update: MessageSquareReply,
  timer: Timer,
  other: CircleDot,
};

const basicCodeExample = `// 教学摘录：先读编排主干；完整校验、状态和补偿见源码
const args = { input, workflowId, total }

// 这些是 proxyActivities 创建的代理调用
await reserveInventory(args)
await chargePayment(args)

// approvalReceived 由已注册的 Signal handler 修改
const approved = await condition(
  () => approvalReceived,
  input.approvalTimeoutSeconds * 1000
)
if (!approved) {
  // 完整实现会在 catch 分支查账退款、释放库存
  throw ApplicationFailure.nonRetryable('确认超时', 'ApprovalTimedOut')
}

await shipOrder(args)

// Worker 重放时，已记录完成结果的 Activity 使用历史结果
// Activity 结果未被确认时仍可能重试，外部操作需要幂等`;

const codeExample = `// 教学摘录：省略共享 applyApproval 实现、状态更新和补偿
// 尽早注册 handler，让客户端及时观察和驱动流程
setHandler(approveSignal, () => {
  if (state.status !== 'waiting_approval' || approvalReceived) return
  applyApproval('signal') // Signal 没有业务返回值
})
setHandler(approveUpdate, (input) => {
  validateApprovalUpdate(input) // handler 再次检查门禁
  const update = currentUpdateInfo()
  if (!update || !applyApproval('update', update.id)) {
    throw ApplicationFailure.nonRetryable('当前订单不允许确认', 'ApprovalNotAllowed')
  }
  return {
    workflowId, runId: workflowInfo().runId,
    updateId: update.id, approvedAt: state.approvedAt, status: 'approved'
  }
}, {
  // 同步只读：未核对订单或当前不允许确认时抛 ApplicationFailure
  validator: validateApprovalUpdate
})

const activityArgs = { input, workflowId, total }
await reserveInventory(activityArgs)

// Activity 内使用 workflowId:charge 幂等扣款
// 扣款后故障会重试，账本仍然只产生一笔扣款
await chargePayment(activityArgs)

const approved = await condition(
  () => approvalReceived,
  input.approvalTimeoutSeconds * 1000
)
if (!approved) {
  throw ApplicationFailure.nonRetryable('确认超时', 'ApprovalTimedOut')
}

if (input.scenario === 'heartbeat' || input.scenario === 'heartbeat_timeout') {
  // 内部 heartbeat(checkpoint)，重试读取 heartbeatDetails
  state.packing = await packOrder(activityArgs)
}
state.trackingNumber = await shipOrder(activityArgs)`;

export function InspectorTabs({ detail, queryFresh = false, responseFresh = false, feedback, initialTab = 'state', expanded = false, onToggleExpanded }: InspectorTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [historyTarget, setHistoryTarget] = useState<{ workflowId: string; runId: string; eventId: string } | null>(null);
  const baseId = useId();
  const target = historyTarget?.workflowId === detail?.workflowId && historyTarget?.runId === detail?.runId ? historyTarget : null;

  useEffect(() => {
    if (activeTab !== 'history' || !target) return;
    const event = document.getElementById(`${baseId}-history-${target.eventId}`);
    event?.focus();
    event?.scrollIntoView?.({ block: 'center' });
  }, [activeTab, target, baseId]);

  function showHistoryEvent(eventId: string) {
    if (!detail || !detail.history.some((event) => event.id === eventId)) return;
    setHistoryTarget({ workflowId: detail.workflowId, runId: detail.runId, eventId });
    setActiveTab('history');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`${baseId}-tab-${nextTab.id}`)?.focus();
  }

  return (
    <section className="panel inspector" aria-labelledby="inspector-title">
      <div className="inspector__heading">
        <div>
          <p className="panel__kicker">Inspect what happened</p>
          <h2 id="inspector-title">深入观察</h2>
        </div>
        <div className="inspector__tools">
          {detail && <code className="run-id" title={detail.runId}>run · {detail.runId.slice(0, 8)}</code>}
          {onToggleExpanded && (
            <button type="button" className="inspector-expand" aria-pressed={expanded} onClick={onToggleExpanded}>
              {expanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
              {expanded ? '返回并排' : '展开阅读'}
            </button>
          )}
        </div>
      </div>

      <div className="tab-list" role="tablist" aria-label="工作流观察视图" onKeyDown={handleKeyDown}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            id={`${baseId}-tab-${id}`}
            className={activeTab === id ? 'is-active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`${baseId}-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => setActiveTab(id)}
            key={id}
          >
            <Icon size={16} aria-hidden={true} />
            {label}
            {id === 'history' && detail && <span>{detail.history.length}</span>}
          </button>
        ))}
      </div>

      {tabs.map(({ id }) => (
        <div
          id={`${baseId}-panel-${id}`}
          className="tab-panel"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`${baseId}-tab-${id}`}
          hidden={activeTab !== id}
          key={id}
        >
        {id === 'state' && (
          detail?.state ? (
            <>
              {(!queryFresh || !responseFresh || detail.stateError) && <p className="inspector-stale" role="status">业务状态为上次快照或暂未取得新鲜 Query；请勿据此判断当前进度。</p>}
              <pre className="json-view"><code>{JSON.stringify(detail.state, null, 2)}</code></pre>
            </>
          ) : (
            <InspectorEmpty icon={Braces} title="还没有业务状态快照" text={detail ? 'Query 暂时不可用；主面板仍会展示 Describe、心跳和支付账本的独立观测。' : '创建或选择一条 Workflow 后，可在这里检查 Query 返回的 JSON。'} />
          )
        )}

        {id === 'history' && (
          detail?.history.length ? (
            <div className="event-view">
              {!responseFresh && <p className="inspector-stale" role="status">History 保留自上次响应，尚未刷新成功；以下事件仅供回看。</p>}
              <details className="history-explainer">
                <summary><Info size={17} aria-hidden="true" />如何理解这些事件</summary>
                <p>
                  这里展示服务端从 Temporal 历史转换出的真实事件。Update 通过校验后可看到 Accepted / Completed；validator 拒绝通常不写入这两类事件，以请求返回为准。Activity 中间重试可能被聚合；心跳来自 Describe，付款流水来自独立 SQLite 账本。
                </p>
              </details>
              <ol className="event-list">
                {detail.history.map((event) => {
                  const Icon = categoryIcons[event.category];
                  return (
                    <li key={event.id} id={`${baseId}-history-${event.id}`} tabIndex={-1} className={target?.eventId === event.id ? 'is-referenced' : undefined}>
                      <span className={`event-list__icon event-list__icon--${event.category}`} aria-hidden="true"><Icon size={16} /></span>
                      <div>
                        <span className="event-list__meta">
                          <code>#{event.id} · {event.type}</code>
                          <span><Clock3 size={13} aria-hidden="true" />{formatDateTime(event.timestamp)}</span>
                        </span>
                        <h3>{event.label}</h3>
                        {event.detail && <p>{event.detail}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            <InspectorEmpty icon={ListTree} title="暂无可显示的事件" text={detail ? '首批历史事件写入后会自动出现。' : '选择一条运行后，可以按时间顺序阅读事件。'} />
          )
        )}

        {id === 'evidence' && (
          <SourceEvidencePanel
            key={`${detail?.workflowId}/${detail?.runId}`}
            detail={detail}
            queryFresh={queryFresh}
            responseFresh={responseFresh}
            feedback={feedback}
            onHistoryEvent={showHistoryEvent}
            active={activeTab === 'evidence'}
          />
        )}

        {id === 'code' && (
          <div className="code-concept">
            <div className="code-concept__intro">
              <div>
                <span className="code-concept__label">Illustrative workflow</span>
                <h3>先看编排主干，再读消息与故障处理</h3>
              </div>
              <p>以下是教学摘录，省略业务状态、打包和完整补偿。先理解 Activity 调用与持久化等待，再读 server/workflows.ts 的完整实现。</p>
            </div>
            <pre aria-label="Workflow 编排主干"><code>{basicCodeExample}</code></pre>
            <div className="code-lessons">
              <p><strong>Workflow 编排，Activity 执行</strong><span>await 调用的是 Activity 代理；Worker 领取任务后执行普通 Node 函数。外部 I/O 放在 Activity 中。</span></p>
              <p><strong>重放使用已记录的结果</strong><span>Server 保存历史，Worker 重放编排代码重建变量。已完成的 Activity 不会因为重放再次调用外部接口。</span></p>
              <p><strong>重试需要业务幂等</strong><span>外部扣款成功但 Activity 结果未被确认时，下一次尝试可能重复执行。账本用稳定幂等键避免重复扣款。</span></p>
            </div>
            <details className="code-concept__advanced">
              <summary>进阶：Signal / Update、支付幂等与心跳摘录</summary>
              <p>理解主干后，再对照 handler 校验、业务返回值和长 Activity 检查点。辅助函数与完整门禁见 server/workflows.ts。</p>
              <pre aria-label="消息与恢复进阶摘录"><code>{codeExample}</code></pre>
              <div className="code-lessons">
                <p><strong>收件回执与业务结果</strong><span>Signal 返回接收确认；Update 返回 handler 的业务结果。二者都不能替代整个 Workflow 的完成结果。</span></p>
                <p><strong>业务与执行状态分离</strong><span>Query 描述业务进度，Describe 给出 Temporal 权威执行状态；两次读取并非原子快照。</span></p>
                <p><strong>心跳保存检查点</strong><span>长 Activity 每批上报 Heartbeat；超时后新尝试从服务端最后检查点恢复，不猜测中间进度。</span></p>
              </div>
            </details>
          </div>
        )}
        </div>
      ))}
    </section>
  );
}

function InspectorEmpty({
  icon: Icon,
  title,
  text,
}: {
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  title: string;
  text: string;
}) {
  return (
    <div className="inspector-empty">
      <Icon size={24} aria-hidden={true} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
