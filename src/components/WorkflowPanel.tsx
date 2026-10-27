import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  Circle,
  Clock3,
  CreditCard,
  ExternalLink,
  LoaderCircle,
  Package,
  Radio,
  ReceiptText,
  RotateCw,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { ApprovalFeedback } from '../../shared/approval';
import { ApprovalComparison } from './ApprovalComparison';
import { WorkspaceTabs } from './WorkspaceTabs';

import type {
  CompensationProgress,
  HealthResponse,
  OrderDetail,
  OrderStep,
  PackingCheckpoint,
  PaymentEntry,
  PendingActivity,
  Scenario,
  StepStatus,
} from '../../shared/types';
import {
  formatDateTime,
  formatMoney,
  isTerminalExecutionStatus,
  isTerminalStatus,
  orderStatusLabel,
  orderStatusTone,
  scenarioLabel,
  stepStatusLabel,
} from '../format';

const runViews = [
  { id: 'steps', label: '流程步骤' },
  { id: 'actions', label: '确认 / 取消' },
  { id: 'effects', label: '心跳 / 账本' },
] as const;
type RunView = typeof runViews[number]['id'];

interface WorkflowPanelProps {
  detail: OrderDetail | null;
  requestedWorkflowId: string | null;
  health: HealthResponse | null;
  servicesReady: boolean;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  observationStale: boolean;
  error: string | null;
  actionError: string | null;
  actionPending: 'approve' | 'update' | 'cancel' | null;
  actionPhase: 'sending' | 'awaiting' | null;
  approvalFeedback: ApprovalFeedback | null;
  updateRecoveryReady: boolean;
  onApprove: () => Promise<void>;
  onUpdate: (confirmed: boolean, recovery?: 'query' | 'retry') => Promise<void>;
  onCancel: () => Promise<void>;
}

const stepIcons: Record<StepStatus, ComponentType<{ size?: number; 'aria-hidden'?: boolean; className?: string }>> = {
  pending: Circle,
  running: LoaderCircle,
  waiting: Radio,
  completed: Check,
  failed: X,
  cancelled: Ban,
};

const compensationStatusLabels: Record<CompensationProgress['status'], string> = {
  idle: '尚未开始',
  running: '补偿执行中',
  completed: '补偿已完成',
  failed: '补偿失败',
};

const compensationStepLabels: Record<CompensationProgress['steps'][number]['status'], string> = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
};

const paymentKindLabels: Record<PaymentEntry['kind'], string> = {
  attempt: '付款尝试',
  debit: '实际扣款',
  reused: '复用已有扣款',
  failure: '尝试失败',
  refund: '退款入账',
};

function buildTemporalWorkflowUrl(health: HealthResponse | null, detail: OrderDetail): string | null {
  if (!health?.temporalUiUrl) return null;
  try {
    const base = new URL(health.temporalUiUrl, window.location.href);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    const rootPath = base.pathname.replace(/\/$/, '');
    base.pathname = `${rootPath}/namespaces/${encodeURIComponent(health.namespace)}/workflows/${encodeURIComponent(detail.workflowId)}/${encodeURIComponent(detail.runId)}/history`;
    return base.toString();
  } catch {
    return null;
  }
}

function WorkflowStepItem({ step, isLast }: { step: OrderStep; isLast: boolean }) {
  const Icon = stepIcons[step.status];
  return (
    <li className={`workflow-step workflow-step--${step.status}`}>
      <div className="workflow-step__rail" aria-hidden="true">
        <span className="workflow-step__icon">
          <Icon className={step.status === 'running' ? 'spin' : undefined} size={17} />
        </span>
        {!isLast && <span className="workflow-step__line" />}
      </div>
      <div className="workflow-step__body">
        <div className="workflow-step__topline">
          <div>
            <span className="workflow-step__kind">{step.kind}</span>
            <h3>{step.label}</h3>
          </div>
          <span className={`step-label step-label--${step.status}`}>{stepStatusLabel(step.status)}</span>
        </div>
        <p>{step.detail}</p>
      </div>
    </li>
  );
}

function StatusOverview({ detail, queryStale, observationStale }: {
  detail: OrderDetail;
  queryStale: boolean;
  observationStale: boolean;
}) {
  const state = detail.state;
  return (
    <div className="status-overview" aria-label="业务状态与 Temporal 执行状态">
      <div className="status-card">
        <span className="status-card__label">业务状态 · Query</span>
        {state ? (
          <span className={`status-badge status-badge--${orderStatusTone(state.status)}`}>
            <span aria-hidden="true" />
            {orderStatusLabel(state.status)}
          </span>
        ) : (
          <strong className="status-card__unavailable">暂不可用</strong>
        )}
        <small>{queryStale ? '保留自同一 Run 的上次快照' : state ? 'Workflow 公开的业务进度' : '当前响应未取得 Query 快照'}</small>
        {queryStale && <span className="freshness-label freshness-label--stale">已过期</span>}
      </div>
      <div className="status-card">
        <span className="status-card__label">执行状态 · Temporal Describe</span>
        <span className={`status-badge status-badge--${orderStatusTone(detail.status)}`}>
          <span aria-hidden="true" />
          {orderStatusLabel(detail.status)}
        </span>
        <small><code>{detail.status}</code> · 本次 Run</small>
        {observationStale && <span className="freshness-label freshness-label--stale">上次响应</span>}
      </div>
      <p className="status-overview__time">
        <Clock3 size={14} aria-hidden="true" />
        响应观测时间 {formatDateTime(detail.observedAt)}；Describe 与 Query 依次读取，不是原子快照。
      </p>
    </div>
  );
}

function CompensationPanel({ progress }: { progress: CompensationProgress }) {
  const tone = progress.status === 'completed' ? 'success' : progress.status === 'failed' ? 'danger' : progress.status === 'running' ? 'running' : 'neutral';
  return (
    <section className="detail-card compensation-card" aria-labelledby="compensation-title">
      <div className="detail-card__header">
        <div>
          <span className="detail-card__eyebrow">Saga recovery</span>
          <h3 id="compensation-title">补偿进度</h3>
        </div>
        <span className={`status-badge status-badge--${tone}`}>
          <span aria-hidden="true" />
          {compensationStatusLabels[progress.status]}
        </span>
      </div>
      <ol className="compensation-steps">
        {progress.steps.map((step) => {
          const Icon = step.status === 'completed' ? Check : step.status === 'failed' ? X : step.status === 'running' ? LoaderCircle : Circle;
          return (
            <li className={`compensation-step compensation-step--${step.status}`} key={step.id}>
              <span className="compensation-step__icon" aria-hidden="true">
                <Icon className={step.status === 'running' ? 'spin' : undefined} size={16} />
              </span>
              <div>
                <span><strong>{step.label}</strong><small>{compensationStepLabels[step.status]}</small></span>
                {step.detail && <p>{step.detail}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function findPackingActivity(activities: PendingActivity[]): PendingActivity | null {
  return activities.find((activity) => activity.heartbeat)
    ?? activities.find((activity) => /pack/i.test(`${activity.activityType} ${activity.activityId}`))
    ?? null;
}

function pendingActivityStateLabel(state: string): string {
  const labels: Record<string, string> = {
    scheduled: '已调度',
    started: '执行中',
    cancel_requested: '已请求取消',
  };
  return labels[state.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? state;
}

function checkpointPhaseLabel(checkpoint: PackingCheckpoint, liveHeartbeat: boolean, finalResult: boolean): string {
  if (finalResult || checkpoint.phase === 'completed') return '打包已完成';
  if (liveHeartbeat) return '正在打包';
  if (checkpoint.phase === 'paused') return '已保存的暂停检查点';
  return '已保存的检查点';
}

function PackingPanel({ detail, queryStale, observationStale }: {
  detail: OrderDetail;
  queryStale: boolean;
  observationStale: boolean;
}) {
  const scenario = detail.state?.input.scenario;
  const activity = findPackingActivity(detail.pendingActivities);
  const finalCheckpoint = activity ? null : detail.state?.packing ?? null;
  const checkpoint = activity?.heartbeat ?? finalCheckpoint;
  const isHeartbeatScenario = scenario === 'heartbeat' || scenario === 'heartbeat_timeout';
  if (!isHeartbeatScenario && !activity && !checkpoint) return null;

  const finalResult = Boolean(finalCheckpoint?.phase === 'completed');
  const liveHeartbeat = Boolean(
    activity
    && checkpoint
    && checkpoint.phase === 'packing'
    && activity.attempt === checkpoint.attempt,
  );
  const sourceStale = observationStale || (!activity && queryStale);
  const sourceLabel = activity ? 'Describe 心跳检查点' : checkpoint ? 'Query 最终结果' : '等待打包 Activity';
  const completed = checkpoint ? Math.max(0, Math.min(checkpoint.completedBatches, checkpoint.totalBatches)) : 0;
  const total = checkpoint ? Math.max(1, checkpoint.totalBatches) : 0;

  return (
    <section className="detail-card packing-card" aria-labelledby="packing-title">
      <div className="detail-card__header">
        <div>
          <span className="detail-card__eyebrow">Heartbeat recovery</span>
          <h3 id="packing-title">分批打包进度</h3>
        </div>
        <span className={`source-label${sourceStale ? ' source-label--stale' : ''}`}>
          {sourceStale ? '过期 · ' : ''}{sourceLabel}
        </span>
      </div>

      {checkpoint ? (
        <>
          <div className="packing-progress__topline">
            <strong>{checkpointPhaseLabel(checkpoint, liveHeartbeat, finalResult)}</strong>
            <span>{completed} / {checkpoint.totalBatches} 批</span>
          </div>
          <progress
            aria-label={`打包已完成 ${completed} 批，共 ${checkpoint.totalBatches} 批`}
            value={completed}
            max={total}
          >
            {completed} / {checkpoint.totalBatches}
          </progress>
          <dl className="packing-facts">
            {activity && <div><dt>当前 Activity 尝试</dt><dd>#{activity.attempt} · {pendingActivityStateLabel(activity.state)}</dd></div>}
            <div><dt>{finalResult ? '完成于尝试' : '检查点来自尝试'}</dt><dd>#{checkpoint.attempt}</dd></div>
            <div><dt>从何处继续</dt><dd>{checkpoint.resumedFrom > 0 ? `第 ${checkpoint.resumedFrom} 批之后` : '从第 1 批开始'}</dd></div>
            <div><dt>{activity?.lastHeartbeatAt ? '最后心跳' : '检查点更新时间'}</dt><dd>{formatDateTime(activity?.lastHeartbeatAt ?? checkpoint.updatedAt)}</dd></div>
          </dl>
          {!liveHeartbeat && activity && (
            <p className="packing-note">
              <Clock3 size={15} aria-hidden="true" />
              这是尝试 #{checkpoint.attempt} 保存的服务器检查点；当前尝试 #{activity.attempt} 的进度不会在没有新心跳时推算。
            </p>
          )}
          {liveHeartbeat && (
            <p className="packing-note packing-note--live">
              <Activity size={15} aria-hidden="true" />
              仅在 Worker 上报心跳后更新，不使用前端计时器模拟进度。
            </p>
          )}
          {activity?.lastFailure && (
            <p className="packing-failure"><AlertTriangle size={15} aria-hidden="true" />{activity.lastFailure}</p>
          )}
        </>
      ) : activity ? (
        <div className="detail-card__empty" role="status">
          <LoaderCircle className="spin" size={20} aria-hidden="true" />
          <div>
            <strong>打包 Activity 已{pendingActivityStateLabel(activity.state)}</strong>
            <p>当前尝试 #{activity.attempt}，尚未收到首个打包心跳，因此不推算批次进度。</p>
          </div>
        </div>
      ) : (
        <div className="detail-card__empty">
          <Package size={20} aria-hidden="true" />
          <div>
            <strong>尚无打包检查点</strong>
            <p>{isTerminalExecutionStatus(detail.status) || (detail.state && isTerminalStatus(detail.state.status))
                ? '本次打包已结束；未取得最终打包结果，可在事件历史中查看已执行的步骤。'
                : detail.state?.status === 'waiting_approval'
                  ? '确认订单后才会启动分批打包。'
                  : 'Activity 开始并发送首个心跳后，这里会显示真实批次进度。'}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function PaymentJournal({ detail, scenario, observationStale }: {
  detail: OrderDetail;
  scenario?: Scenario;
  observationStale: boolean;
}) {
  const [open, setOpen] = useState(scenario === 'idempotency');
  useEffect(() => {
    if (scenario === 'idempotency') setOpen(true);
  }, [scenario]);

  const ledger = detail.payment;
  const hasEntries = ledger.entries.length > 0;

  return (
    <details className="payment-journal" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="payment-journal__summary-icon" aria-hidden="true"><CreditCard size={18} /></span>
        <span>
          <strong>支付幂等账本</strong>
          <small>{hasEntries ? `Activity 尝试 ${ledger.attempts} 次 · 实际扣款 ${ledger.debitCount} 次` : '暂无本地账本记录'}</small>
        </span>
        <span className={`source-label${observationStale ? ' source-label--stale' : ''}`}>
          {observationStale ? '上次响应' : 'SQLite 最新读取'}
        </span>
      </summary>
      <div className="payment-journal__body">
        <p className="payment-journal__notice">
          <ShieldCheck size={16} aria-hidden="true" />
          教学用持久化账本，独立于 Workflow Query；不代表真实外部支付。
        </p>
        {hasEntries ? (
          <>
            <div className="idempotency-key">
              <span>幂等键</span>
              <code>{ledger.idempotencyKey}</code>
            </div>
            <dl className="ledger-metrics">
              <div><dt>付款尝试</dt><dd>{ledger.attempts}</dd></div>
              <div><dt>实际扣款</dt><dd>{ledger.debitCount}</dd></div>
              <div><dt>扣款合计</dt><dd>{formatMoney(ledger.totalCharged)}</dd></div>
              <div><dt>退款</dt><dd>{ledger.refundCount} 笔 · {formatMoney(ledger.totalRefunded)}</dd></div>
            </dl>
            <ol className="ledger-entries" aria-label="支付账本流水">
              {ledger.entries.map((entry) => (
                <li key={entry.id}>
                  <span className={`ledger-entry__kind ledger-entry__kind--${entry.kind}`}>{paymentKindLabels[entry.kind]}</span>
                  <div>
                    <span><strong>尝试 #{entry.attempt}</strong><time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time></span>
                    <p>{entry.message}</p>
                  </div>
                  {entry.amount !== 0 && <strong className="ledger-entry__amount">{formatMoney(entry.amount)}</strong>}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="payment-journal__empty">
            <ReceiptText size={20} aria-hidden="true" />
            <p><strong>暂无本地账本记录</strong><span>升级前的旧订单不会补写，因此不能据此判断是否曾付款。</span></p>
          </div>
        )}
      </div>
    </details>
  );
}

export function WorkflowPanel({
  detail,
  requestedWorkflowId,
  health,
  servicesReady,
  loading,
  refreshing,
  stale,
  observationStale,
  error,
  actionError,
  actionPending,
  actionPhase,
  approvalFeedback,
  updateRecoveryReady,
  onApprove,
  onUpdate,
  onCancel,
}: WorkflowPanelProps) {
  const state = detail?.state ?? null;
  const executionTerminal = detail ? isTerminalExecutionStatus(detail.status) : false;
  const controlsFresh = !stale && !observationStale && !error;
  const canApprove = servicesReady && !executionTerminal && state?.status === 'waiting_approval'
    && controlsFresh && actionPending === null && approvalFeedback?.status !== 'approved';
  const canCancel = servicesReady && !executionTerminal && Boolean(state && !isTerminalStatus(state.status)) && controlsFresh && actionPending === null;
  const temporalWorkflowUrl = detail ? buildTemporalWorkflowUrl(health, detail) : null;
  const actionAwaiting = actionPhase === 'awaiting';
  const [view, setView] = useState<RunView>('steps');
  useEffect(() => setView('steps'), [detail?.runId]);
  const needsApproval = state?.status === 'waiting_approval' && !executionTerminal;

  return (
    <section className="panel workflow-panel" aria-labelledby="workflow-path-title" aria-busy={loading}>
      <div className="workflow-panel__header">
        <div className="panel__heading panel__heading--compact">
          <div className="panel__number" aria-hidden="true">02</div>
          <div>
            <p className="panel__kicker">Observe durable state</p>
            <h2 id="workflow-path-title">工作流路径</h2>
          </div>
        </div>
        {detail && (
          <div className="workflow-panel__header-actions">
            {refreshing && <LoaderCircle className="spin quiet-spinner" size={17} aria-label="正在刷新" />}
            {temporalWorkflowUrl && (
              <a className="text-link" href={temporalWorkflowUrl} target="_blank" rel="noreferrer">
                在 Temporal UI 查看
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>

      {detail && observationStale && (
        <div className="stale-banner" role="status">
          <RotateCw size={17} aria-hidden="true" />
          <span>暂时无法刷新；业务状态、执行状态、心跳与支付账本均保留自上次响应，正在自动重试。</span>
        </div>
      )}
      {detail && !observationStale && (stale || detail.stateError) && (
        <div className="stale-banner" role="status">
          <RotateCw size={17} aria-hidden="true" />
          <span>
            Query 暂不可用；{stale ? '业务状态保留自同一 Run 的上次快照。' : '当前没有业务状态快照。'}
            Temporal 执行状态、Describe 心跳与支付账本仍来自这次新响应。
          </span>
        </div>
      )}

      {!requestedWorkflowId ? (
        <div className="workflow-empty">
          <span className="workflow-empty__icon" aria-hidden="true"><Workflow size={26} /></span>
          <h3>准备观察第一条 Workflow</h3>
          <p>从左侧创建实验订单，或从“最近实验”中选择一次运行。真实步骤会在 Query 返回后出现在这里。</p>
        </div>
      ) : loading && !detail ? (
        <div className="workflow-empty" role="status">
          <span className="workflow-empty__icon" aria-hidden="true"><LoaderCircle className="spin" size={26} /></span>
          <h3>正在读取 Workflow</h3>
          <p><code>{requestedWorkflowId}</code></p>
        </div>
      ) : error && !detail ? (
        <div className="workflow-empty workflow-empty--error" role="alert">
          <span className="workflow-empty__icon" aria-hidden="true"><AlertTriangle size={26} /></span>
          <h3>暂时无法读取这条运行</h3>
          <p>{error}</p>
          <p className="workflow-empty__hint">页面会自动重试；也可以选择另一条历史记录。</p>
        </div>
      ) : detail ? (
        <>
          <StatusOverview detail={detail} queryStale={stale} observationStale={observationStale} />

          <div className="run-workspace-nav">
            {(needsApproval || approvalFeedback?.status === 'unknown') && view !== 'actions' && (
              <div className="run-action-prompt">
                <span>{approvalFeedback?.status === 'unknown' ? 'Update 结果未知，请核对原请求' : '正在等待你的人工确认'}</span>
                <button type="button" onClick={() => {
                  setView('actions');
                  document.getElementById('run-view-tab-actions')?.focus();
                }}>
                  {approvalFeedback?.status === 'unknown' ? '查看恢复操作' : '前往确认'}
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
            <WorkspaceTabs id="run-view" label="当前运行视图" items={runViews} value={view} onChange={setView} />
          </div>

          <div className="run-detail-pane" role="tabpanel" id="run-view-panel-steps" aria-labelledby="run-view-tab-steps" hidden={view !== 'steps'} tabIndex={0}>
          <details className="workflow-meta">
            <summary>{state ? `${state.input.customerName} · ${scenarioLabel(state.input.scenario)} · ${formatMoney(state.total)}` : '运行标识与 Query 状态'}<span>运行详情</span></summary>
            <div className="workflow-meta__identity">
              <code title={detail.workflowId}>{detail.workflowId}</code>
            </div>
            {state ? (
              <dl>
                <div><dt>客户</dt><dd>{state.input.customerName}</dd></div>
                <div><dt>金额</dt><dd>{formatMoney(state.total)}</dd></div>
                <div><dt>情景</dt><dd>{scenarioLabel(state.input.scenario)}</dd></div>
                <div><dt>业务快照更新</dt><dd>{formatDateTime(state.updatedAt)}</dd></div>
              </dl>
            ) : (
              <p className="query-unavailable">
                <AlertTriangle size={15} aria-hidden="true" />
                {detail.stateError || 'Query 正在初始化；执行状态与独立观测数据仍可查看。'}
              </p>
            )}
          </details>

          {state && (
            <ol className="workflow-steps" aria-label="订单工作流步骤">
              {state.steps.map((step, index) => (
                <WorkflowStepItem key={step.id} step={step} isLast={index === state.steps.length - 1} />
              ))}
            </ol>
          )}

          {state && (state.error || state.compensation || state.trackingNumber) && (
            <div className="outcome-notes">
              {state.error && (
                <div className="outcome-note outcome-note--danger">
                  <AlertTriangle size={17} aria-hidden="true" />
                  <span><strong>错误</strong>{state.error}</span>
                </div>
              )}
              {state.compensation && (
                <div className="outcome-note">
                  <RotateCw size={17} aria-hidden="true" />
                  <span><strong>补偿结果</strong>{state.compensation}</span>
                </div>
              )}
              {state.trackingNumber && (
                <div className="outcome-note outcome-note--success">
                  <Check size={17} aria-hidden="true" />
                  <span><strong>物流单号</strong><code>{state.trackingNumber}</code></span>
                </div>
              )}
            </div>
          )}

          </div>

          <div className="run-detail-pane" role="tabpanel" id="run-view-panel-effects" aria-labelledby="run-view-tab-effects" hidden={view !== 'effects'} tabIndex={0}>
            <div className="workflow-observability">
              <PackingPanel detail={detail} queryStale={stale} observationStale={observationStale} />
              {state?.compensationProgress && <CompensationPanel progress={state.compensationProgress} />}
              <PaymentJournal key={detail.runId} detail={detail} scenario={state?.input.scenario} observationStale={observationStale} />
            </div>
          </div>

          <div className="run-detail-pane" role="tabpanel" id="run-view-panel-actions" aria-labelledby="run-view-tab-actions" hidden={view !== 'actions'} tabIndex={0}>
          {(state || approvalFeedback) && (
            <ApprovalComparison
              key={detail.runId}
              detail={detail}
              canApprove={Boolean(canApprove)}
              pending={actionPending}
              awaiting={actionAwaiting}
              feedback={approvalFeedback}
              recoveryReady={updateRecoveryReady}
              onSignal={onApprove}
              onUpdate={onUpdate}
            />
          )}

          {state && (
            <div className="workflow-actions">
              {canCancel || actionPending === 'cancel' ? (
                <button className="danger-button" type="button" disabled={!canCancel} onClick={() => void onCancel()}>
                  {actionPending === 'cancel' ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Ban size={16} aria-hidden="true" />}
                  {actionPending === 'cancel'
                    ? actionAwaiting ? '已请求，等待关闭…' : '正在请求取消…'
                    : '取消这条 Workflow'}
                </button>
              ) : null}
            </div>
          )}

          </div>

          {actionError && (
            <p className="action-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {actionError}
            </p>
          )}

          {(stale || observationStale || error || !servicesReady || executionTerminal || actionPending) && (
            <p className="control-lock-note">
              <Clock3 size={15} aria-hidden="true" />
              {actionPending
                ? actionAwaiting
                  ? '请求已被 API 接受；操作保持锁定，直到新响应证明 Workflow 已转换状态。'
                  : '请求正在发送，操作暂时锁定。'
                : executionTerminal
                  ? 'Temporal 已将这次 Run 标记为终态，不再接受确认或取消操作。'
                  : servicesReady
                    ? '操作已暂时锁定，避免依据过期或缺失的 Query 状态发送指令。'
                    : 'Temporal 或 Worker 当前不可用，操作已暂时锁定。'}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
