import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FilePenLine, FlaskConical, LayoutPanelLeft, LoaderCircle, Network } from 'lucide-react';
import type { ApprovalUpdateRequest, CreateOrderResponse, HealthResponse, OrderDetail, OrderInput, OrderSummary } from '../shared/types';
import type { ApprovalFeedback } from '../shared/approval';
import { ApiError, api, getErrorMessage, isAbortError } from './api';
import { isTerminalExecutionStatus } from './format';
import { DisconnectedState } from './components/DisconnectedState';
import { Header } from './components/Header';
import { InspectorTabs } from './components/InspectorTabs';
import { LearningGuide } from './components/LearningGuide';
import { LearningPractice } from './components/LearningPractice';
import { OrderForm } from './components/OrderForm';
import { OrderHistory } from './components/OrderHistory';
import { RecoveryGuide } from './components/RecoveryGuide';
import { WorkflowPanel } from './components/WorkflowPanel';
import { WorkspaceTabs } from './components/WorkspaceTabs';

const workspaces = [
  { id: 'lab', label: '实验台', icon: LayoutPanelLeft, hash: '#lab' },
  { id: 'recovery', label: '恢复实验', icon: FlaskConical, hash: '#recovery' },
  { id: 'guide', label: '学习路线', icon: BookOpen, hash: '#learning-guide' },
  { id: 'notes', label: '自测笔记', icon: FilePenLine, hash: '#learning-practice' },
] as const;
type Workspace = typeof workspaces[number]['id'];
const mobileViews = [
  { id: 'setup', label: '创建 / 最近' },
  { id: 'run', label: '当前运行' },
  { id: 'inspect', label: '运行证据' },
] as const;
type MobileView = typeof mobileViews[number]['id'];
const setupViews = [
  { id: 'create', label: '创建订单' },
  { id: 'history', label: '最近实验' },
] as const;

function workspaceForHash(hash: string): Workspace {
  if (hash === '#recovery' || hash === '#recovery-title') return 'recovery';
  if (hash === '#learning-guide') return 'guide';
  if (hash === '#learning-practice') return 'notes';
  return 'lab';
}

const HEALTH_POLL_MS = 3_000;
const ORDERS_POLL_MS = 4_000;
const DETAIL_POLL_MS = 1_500;

type WorkflowAction = 'approve' | 'update' | 'cancel';
type WorkflowActionPhase = 'sending' | 'awaiting';

interface ScopedActionState {
  id: number;
  workflowId: string;
  runId: string;
  kind: WorkflowAction;
  phase: WorkflowActionPhase;
}

interface ScopedActionError {
  workflowId: string;
  runId: string;
  message: string;
}

function isSameRun(detail: OrderDetail, workflowId: string, runId: string): boolean {
  return detail.workflowId === workflowId && detail.runId === runId;
}

function transitionObserved(action: ScopedActionState, detail: OrderDetail): boolean {
  if (!isSameRun(detail, action.workflowId, action.runId)) return false;
  // Update 的 RPC 结果由自己的请求收尾，状态推进不替代 handler 返回值。
  if (action.kind === 'update') return false;
  if (isTerminalExecutionStatus(detail.status)) return true;
  if (!detail.state) return false;
  return action.kind === 'approve'
    ? detail.state.status !== 'waiting_approval'
    : detail.state.status === 'cancelled';
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRefreshing, setDetailRefreshing] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailStale, setDetailStale] = useState(false);
  const [detailObservationStale, setDetailObservationStale] = useState(false);
  const [detailPollVersion, setDetailPollVersion] = useState(0);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Record<string, ScopedActionState>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, ScopedActionError>>({});
  const [approvalFeedback, setApprovalFeedback] = useState<Record<string, ApprovalFeedback>>({});
  const [guideOpen, setGuideOpen] = useState(() => workspaceForHash(window.location.hash) === 'guide');
  const [recoveryActive, setRecoveryActive] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>(() => workspaceForHash(window.location.hash));
  const [mobileView, setMobileView] = useState<MobileView>('setup');
  const [setupView, setSetupView] = useState<'create' | 'history'>('create');
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<string | null>(null);
  const actionSequence = useRef(0);

  useEffect(() => {
    function navigate() {
      const hash = window.location.hash;
      if (hash === '#main-content') return;
      const next = workspaceForHash(hash);
      setWorkspace(next);
      if (next === 'guide') setGuideOpen(true);
      if (hash === '#create-order-title' || ['#customerName', '#quantity', '#approvalTimeoutSeconds'].includes(hash)) {
        setSetupView('create');
        setMobileView('setup');
        setEvidenceExpanded(false);
      }
      setNavigationTarget(hash.slice(1) || 'workspace-title');
    }
    window.addEventListener('hashchange', navigate);
    window.addEventListener('popstate', navigate);
    return () => {
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('popstate', navigate);
    };
  }, []);

  useEffect(() => {
    if (!navigationTarget) return;
    const target = document.getElementById(navigationTarget) ?? document.getElementById('workspace-title');
    if (target && target.tabIndex < 0) target.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
    setNavigationTarget(null);
  }, [navigationTarget, workspace, mobileView, setupView]);

  function openWorkspace(next: Workspace) {
    setWorkspace(next);
    if (next === 'guide') setGuideOpen(true);
    if (next === 'lab') setEvidenceExpanded(false);
    setNavigationTarget(next === 'recovery' ? 'recovery-title' : next === 'notes' ? 'learning-practice-title' : next === 'guide' ? 'learning-guide-title' : 'workspace-title');
  }

  function toggleGuide() {
    if (workspace !== 'guide') {
      window.history.pushState(null, '', '#learning-guide');
      openWorkspace('guide');
    } else setGuideOpen((open) => !open);
  }

  const connected = Boolean(health?.temporal && health.worker && !healthError);
  const visibleDetail = detail?.workflowId === selectedWorkflowId ? detail : null;
  const visibleActionState = visibleDetail
    ? actionStates[`${visibleDetail.workflowId}/${visibleDetail.runId}`] ?? null : null;
  const visibleActionError = visibleDetail
    ? actionErrors[`${visibleDetail.workflowId}/${visibleDetail.runId}`]?.message ?? null : null;
  const visibleApprovalFeedback = visibleDetail
    ? approvalFeedback[`${visibleDetail.workflowId}/${visibleDetail.runId}`] ?? null : null;
  const recordApprovalFeedback = (feedback: ApprovalFeedback) => {
    setApprovalFeedback((current) => ({ ...current, [`${feedback.workflowId}/${feedback.runId}`]: feedback }));
  };
  function recordAction(action: ScopedActionState) {
    setActionStates((current) => ({ ...current, [`${action.workflowId}/${action.runId}`]: action }));
  }

  function finishAction(target: OrderDetail, id: number, awaiting = false) {
    setActionStates((current) => {
      const key = `${target.workflowId}/${target.runId}`;
      if (current[key]?.id !== id) return current;
      if (awaiting) return { ...current, [key]: { ...current[key], phase: 'awaiting' } };
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function clearActionError(target: OrderDetail) {
    setActionErrors((current) => {
      const key = `${target.workflowId}/${target.runId}`;
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function recordActionError(error: ScopedActionError) {
    setActionErrors((current) => ({ ...current, [`${error.workflowId}/${error.runId}`]: error }));
  }

  const environmentMessage = useMemo(() => {
    if (healthError) return healthError;
    if (health && !health.temporal) return health.message || 'API 已启动，但尚未连接到 Temporal Server。';
    if (health && !health.worker) return health.message || 'Temporal Server 可用，但 Worker 尚未开始轮询 Task Queue。';
    return '先启动 Temporal、API、Worker 与前端开发服务器。';
  }, [health, healthError]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const pollHealth = async () => {
      controller = new AbortController();
      try {
        const nextHealth = await api.getHealth(controller.signal);
        if (disposed) return;
        setHealth(nextHealth);
        setHealthError(null);
      } catch (error) {
        if (disposed || isAbortError(error)) return;
        setHealthError(getErrorMessage(error));
      } finally {
        if (!disposed) {
          setHealthChecked(true);
          timer = window.setTimeout(() => void pollHealth(), HEALTH_POLL_MS);
        }
      }
    };

    void pollHealth();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const pollOrders = async () => {
      controller = new AbortController();
      try {
        const response = await api.getOrders(controller.signal);
        if (disposed) return;
        setOrders(response.orders);
        setOrdersError(null);
        setSelectedWorkflowId((current) => current ?? response.orders[0]?.workflowId ?? null);
      } catch (error) {
        if (disposed || isAbortError(error)) return;
        setOrdersError(getErrorMessage(error));
      } finally {
        if (!disposed) {
          setOrdersLoading(false);
          timer = window.setTimeout(() => void pollOrders(), ORDERS_POLL_MS);
        }
      }
    };

    void pollOrders();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkflowId) {
      setDetail(null);
      setDetailLoading(false);
      setDetailRefreshing(false);
      setDetailError(null);
      setDetailStale(false);
      setDetailObservationStale(false);
      return;
    }

    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const matchingDetail = detail?.workflowId === selectedWorkflowId ? detail : null;
    let hasSuccessfulDetail = matchingDetail !== null;
    let lastKnownState = matchingDetail?.state ?? null;
    let lastKnownStateRunId = matchingDetail?.state ? matchingDetail.runId : null;

    if (!matchingDetail) {
      setDetail(null);
      setDetailError(null);
      setDetailStale(false);
      setDetailObservationStale(false);
    }
    setDetailLoading(!matchingDetail);
    setDetailRefreshing(Boolean(matchingDetail));

    const pollDetail = async () => {
      controller = new AbortController();
      try {
        const nextDetail = await api.getOrder(selectedWorkflowId, controller.signal);
        if (disposed) return;
        hasSuccessfulDetail = true;
        if (nextDetail.state) {
          lastKnownState = nextDetail.state;
          lastKnownStateRunId = nextDetail.runId;
          setDetail(nextDetail);
          setDetailError(null);
          setDetailStale(false);
        } else if (lastKnownState && lastKnownStateRunId === nextDetail.runId) {
          setDetail({ ...nextDetail, state: lastKnownState });
          setDetailError(nextDetail.stateError || 'Query 暂时未返回状态快照。');
          setDetailStale(true);
        } else {
          lastKnownState = null;
          lastKnownStateRunId = null;
          setDetail(nextDetail);
          setDetailError(nextDetail.stateError || null);
          setDetailStale(false);
        }
        setDetailObservationStale(false);
        setActionStates((current) => {
          const key = `${nextDetail.workflowId}/${nextDetail.runId}`;
          if (!current[key] || !transitionObserved(current[key], nextDetail)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      } catch (error) {
        if (disposed || isAbortError(error)) return;
        setDetailError(getErrorMessage(error));
        setDetailStale(Boolean(lastKnownState));
        setDetailObservationStale(hasSuccessfulDetail);
      } finally {
        if (!disposed) {
          setDetailLoading(false);
          setDetailRefreshing(false);
          timer = window.setTimeout(() => {
            setDetailRefreshing(hasSuccessfulDetail);
            void pollDetail();
          }, DETAIL_POLL_MS);
        }
      }
    };

    void pollDetail();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [selectedWorkflowId, detailPollVersion]);

  const selectWorkflow = useCallback((workflowId: string) => {
    if (selectedWorkflowId === workflowId) return;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setDetailStale(false);
    setDetailObservationStale(false);
    setSelectedWorkflowId(workflowId);
  }, [selectedWorkflowId]);

  async function createOrder(input: OrderInput): Promise<CreateOrderResponse | null> {
    setCreatePending(true);
    setCreateError(null);
    const controller = new AbortController();
    try {
      const created = await api.createOrder(input, controller.signal);
      setSelectedWorkflowId(created.workflowId);
      setDetail(null);
      setDetailError(null);
      setDetailStale(false);
      setDetailObservationStale(false);
      setDetailPollVersion((version) => version + 1);
      return created;
    } catch (error) {
      if (!isAbortError(error)) setCreateError(getErrorMessage(error));
      return null;
    } finally {
      setCreatePending(false);
    }
  }

  async function approveOrder() {
    const target = visibleDetail;
    if (!connected || !target?.state || detailStale || detailObservationStale || visibleActionState
      || visibleApprovalFeedback?.status === 'unknown' || target.state.status !== 'waiting_approval'
      || isTerminalExecutionStatus(target.status)) return;
    const actionId = ++actionSequence.current;
    const pending: ScopedActionState = {
      id: actionId,
      workflowId: target.workflowId,
      runId: target.runId,
      kind: 'approve',
      phase: 'sending',
    };
    recordAction(pending);
    clearActionError(target);
    try {
      const receipt = await api.approveOrder(target.workflowId);
      recordApprovalFeedback({ ...receipt, method: 'signal' });
      finishAction(target, actionId, true);
      setDetailPollVersion((version) => version + 1);
    } catch (error) {
      finishAction(target, actionId);
      recordActionError({
        workflowId: target.workflowId,
        runId: target.runId,
        message: `确认 Signal 发送失败：${getErrorMessage(error)}`,
      });
    }
  }

  async function approveOrderUpdate(confirmed: boolean, recovery?: 'query' | 'retry') {
    const target = visibleDetail;
    if (!target || visibleActionState || !health?.temporal || healthError) return;
    const previous = visibleApprovalFeedback?.status === 'unknown' ? visibleApprovalFeedback.request : undefined;
    if (recovery && !previous) return;
    if (!recovery && (!connected || !target.state || detailStale || detailObservationStale
      || target.state.status !== 'waiting_approval' || isTerminalExecutionStatus(target.status))) return;
    const input: ApprovalUpdateRequest = previous && recovery ? previous : {
      confirmed, runId: target.runId, updateId: crypto.randomUUID(),
    };
    const actionId = ++actionSequence.current;
    recordAction({ id: actionId, workflowId: target.workflowId, runId: target.runId, kind: 'update', phase: 'sending' });
    clearActionError(target);
    try {
      const result = recovery === 'query'
        ? await api.getApprovalUpdate(target.workflowId, input.runId, input.updateId)
        : await api.approveOrderUpdate(target.workflowId, input);
      recordApprovalFeedback({
        workflowId: target.workflowId, runId: input.runId, method: 'update', status: result.status,
        request: input,
        message: result.status === 'approved'
          ? 'Update handler 已完成订单确认；后续打包或发货仍由 Workflow 继续执行。'
          : result.message,
        ...(result.status === 'approved' ? { result } : {}),
      });
    } catch (error) {
      const rejected = error instanceof ApiError && error.outcome === 'rejected';
      recordApprovalFeedback({
        workflowId: target.workflowId, runId: input.runId, method: 'update',
        status: rejected ? 'rejected' : 'unknown', request: input,
        message: rejected ? getErrorMessage(error)
          : `尚未取得确定的 Update 结果：${getErrorMessage(error)}。请保留此 ID 查询或重试同一请求。`,
      });
    } finally {
      finishAction(target, actionId);
      setDetailPollVersion((version) => version + 1);
    }
  }

  async function cancelOrder() {
    const target = visibleDetail;
    if (!connected || !target?.state || detailStale || detailObservationStale || visibleActionState || isTerminalExecutionStatus(target.status)) return;
    const confirmed = window.confirm('确定取消这条正在运行的 Workflow 吗？取消后无法继续执行。');
    if (!confirmed) return;
    const actionId = ++actionSequence.current;
    const pending: ScopedActionState = {
      id: actionId,
      workflowId: target.workflowId,
      runId: target.runId,
      kind: 'cancel',
      phase: 'sending',
    };
    recordAction(pending);
    clearActionError(target);
    try {
      await api.cancelOrder(target.workflowId);
      finishAction(target, actionId, true);
      setDetailPollVersion((version) => version + 1);
    } catch (error) {
      finishAction(target, actionId);
      recordActionError({
        workflowId: target.workflowId,
        runId: target.runId,
        message: `取消失败：${getErrorMessage(error)}`,
      });
    }
  }

  return (
    <div className="app-shell lab-app">
      <Header
        health={health}
        healthError={healthError}
        guideOpen={workspace === 'guide' && guideOpen}
        onToggleGuide={toggleGuide}
      />

      <main id="main-content" className="lab-main" tabIndex={-1}>
        <div className="lab-toolbar">
          <div className="lab-title"><h1 id="workspace-title" tabIndex={-1}>订单工作流实验室</h1><p>操作、观察、对照证据</p></div>
          <nav className="lab-navigation" aria-label="实验室工作区">
            {workspaces.map(({ id, label, icon: Icon, hash }) => (
              <a key={id} href={hash} aria-current={workspace === id ? 'page' : undefined} onClick={(event) => {
                event.preventDefault();
                window.history.pushState(null, '', hash);
                openWorkspace(id);
              }}>
                <Icon size={16} aria-hidden="true" />{label}
                {id === 'recovery' && recoveryActive && <span className="lab-observing">观察中</span>}
              </a>
            ))}
          </nav>
        </div>

        <div className="lab-environment">
          {!healthChecked ? (
            <div className="environment-check" role="status">
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
              正在检查本地 Temporal 与 Worker…
            </div>
          ) : recoveryActive && health?.temporal && !healthError ? (
            <div className="environment-ready" role="status">
              <Network size={16} aria-hidden="true" />
              <span>恢复实验观察中 · Temporal 与 API 可用</span>
              <span>Worker 进程请以独立终端为准，轮询记录可能滞后。</span>
            </div>
          ) : !connected ? (
            <DisconnectedState message={environmentMessage} />
          ) : (
            <div className="environment-ready" role="status">
              <Network size={16} aria-hidden="true" />
              <span>已连接命名空间 <code>{health?.namespace}</code></span>
              <span>Task Queue <code>{health?.taskQueue}</code></span>
            </div>
          )}
        </div>

        <div className="lab-workspace lab-reading-workspace" id="recovery" hidden={workspace !== 'recovery'}>
          <RecoveryGuide
            expanded
            active={workspace === 'recovery'}
            detail={visibleDetail}
            health={health}
            servicesReady={connected}
            queryFresh={Boolean(visibleDetail?.state && !visibleDetail.stateError && !detailStale && !detailObservationStale)}
            responseFresh={Boolean(visibleDetail && !detailObservationStale)}
            createPending={createPending}
            createError={createError}
            actionPending={Boolean(visibleActionState)}
            actionError={visibleActionError}
            onCreate={createOrder}
            onApprove={approveOrder}
            onSelect={selectWorkflow}
            onSessionChange={setRecoveryActive}
          />
        </div>

        <div className="lab-workspace lab-reading-workspace" hidden={workspace !== 'guide'}>
          <LearningGuide open={guideOpen} onToggle={toggleGuide} onNavigate={(target) => {
            window.history.pushState(null, '', `#${target}`);
            openWorkspace(target === 'learning-practice' ? 'notes' : 'lab');
            if (target === 'create-order-title') { setSetupView('create'); setMobileView('setup'); }
            setNavigationTarget(target);
          }} />
        </div>
        <div className="lab-workspace lab-reading-workspace" hidden={workspace !== 'notes'}>
          <LearningPractice expanded />
        </div>

        <div className={`lab-workspace lab-experiment${evidenceExpanded ? ' is-evidence-expanded' : ''}`} id="lab" hidden={workspace !== 'lab'}>
          <WorkspaceTabs id="lab-mobile" label="实验台视图" className="lab-mobile-tabs" items={mobileViews} value={mobileView} onChange={setMobileView} />
          <div className="lab-columns">
            <section className="lab-column lab-setup" id="lab-mobile-panel-setup" role="tabpanel" aria-labelledby="lab-mobile-tab-setup" data-mobile-active={mobileView === 'setup'}>
              <WorkspaceTabs id="lab-setup" label="实验选择" items={setupViews} value={setupView} onChange={setSetupView} />
              <div className="lab-scroll-pane" role="tabpanel" id="lab-setup-panel-create" aria-labelledby="lab-setup-tab-create" hidden={setupView !== 'create'}>
                <OrderForm compact connected={connected} pending={createPending} requestError={createError} onSubmit={async (input) => {
                  if (await createOrder(input)) {
                    setMobileView('run');
                    setNavigationTarget('workflow-path-title');
                  }
                }} />
              </div>
              <div className="lab-scroll-pane" role="tabpanel" id="lab-setup-panel-history" aria-labelledby="lab-setup-tab-history" hidden={setupView !== 'history'}>
                <OrderHistory orders={orders} selectedWorkflowId={selectedWorkflowId} loading={ordersLoading} error={ordersError} onSelect={(id) => {
                  selectWorkflow(id);
                  setMobileView('run');
                  setNavigationTarget('workflow-path-title');
                }} />
              </div>
            </section>
            <section className="lab-column lab-run" id="lab-mobile-panel-run" role="tabpanel" aria-labelledby="lab-mobile-tab-run" data-mobile-active={mobileView === 'run'}>
              <WorkflowPanel
                detail={visibleDetail}
                requestedWorkflowId={selectedWorkflowId}
                health={health}
                servicesReady={connected}
                loading={detailLoading}
                refreshing={detailRefreshing}
                stale={detailStale}
                observationStale={detailObservationStale}
                error={detailError}
                actionError={visibleActionError}
                actionPending={visibleActionState?.kind ?? null}
                actionPhase={visibleActionState?.phase ?? null}
                approvalFeedback={visibleApprovalFeedback}
                updateRecoveryReady={Boolean(health?.temporal && !healthError && !visibleActionState)}
                onApprove={approveOrder}
                onUpdate={approveOrderUpdate}
                onCancel={cancelOrder}
              />
            </section>
            <section className="lab-column lab-inspect" id="lab-mobile-panel-inspect" role="tabpanel" aria-labelledby="lab-mobile-tab-inspect" data-mobile-active={mobileView === 'inspect'}>
              <InspectorTabs
                expanded={evidenceExpanded}
                onToggleExpanded={() => {
                  setEvidenceExpanded((value) => !value);
                  setMobileView('inspect');
                }}
                detail={visibleDetail}
                queryFresh={Boolean(visibleDetail?.state && !visibleDetail.stateError && !detailStale && !detailObservationStale)}
                responseFresh={Boolean(visibleDetail && !detailObservationStale)}
                feedback={visibleApprovalFeedback}
              />
            </section>
          </div>
        </div>
      </main>

      <footer className="lab-footer">
        <span>真实 Temporal 执行 · 关闭页面不会终止 Workflow</span>
        <span>History 与支付账本独立记录</span>
      </footer>
    </div>
  );
}
