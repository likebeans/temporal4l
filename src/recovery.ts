import { APPROVE_SIGNAL, APPROVE_UPDATE } from '../shared/types';
import type {
  HistoryEvent,
  OrderDetail,
  PackingCheckpoint,
  PendingActivity,
} from '../shared/types';

export type RecoveryMode = 'approval' | 'packing';

export interface RecoveryBaseline {
  mode: RecoveryMode;
  workflowId: string;
  runId: string;
  capturedAt: string;
  historyEventId: number;
  paymentAttempts: number;
  debitCount: number;
  totalCharged: number;
  completedActivityEventIds: string[];
  packing?: PackingCheckpoint;
}

export interface RecoveryEvidence {
  queryInterrupted: boolean;
  queryRestored: boolean;
  signalEventId?: string;
  resumedPacking?: PackingCheckpoint;
  postBaselineWorkflowTask: boolean;
  interruptionHistoryEventId?: number;
  interruptionObservedAt?: string;
  lastObservedAt?: string;
  lastHistoryEventId?: number;
  invalidReason?: string;
}

export interface RecoverySession {
  baseline: RecoveryBaseline;
  phase: 'captured' | 'stopped' | 'restarted';
  phaseResponseAt: string;
  evidence: RecoveryEvidence;
}

export interface RecoveryCheck {
  id: string;
  label: string;
  status: 'pending' | 'pass' | 'fail';
  detail: string;
}

interface PackingObservation {
  latestAttempt: number;
  checkpoint?: PackingCheckpoint;
}

const CHECK_LABELS = {
  identity: '工作流身份一致',
  interruption: 'Query 中断并恢复',
  payment: '付款没有再次调用',
  history: '历史连续且继续推进',
  completion: '工作流恢复完成',
  signal: '确认 Signal 已持久化',
  checkpoint: '打包从检查点恢复',
} as const;

function cloneCheckpoint(checkpoint: PackingCheckpoint): PackingCheckpoint {
  return { ...checkpoint };
}

function eventId(event: HistoryEvent): number {
  const id = Number(event.id);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function historyBoundary(detail: OrderDetail): number {
  return detail.history.reduce((maximum, event) => Math.max(maximum, eventId(event)), 0);
}

function normalizedExecutionStatus(status: string): string {
  const normalized = status.trim().toUpperCase()
    .replace(/^WORKFLOW_EXECUTION_STATUS_/, '');
  return normalized === 'CANCELLED' ? 'CANCELED' : normalized;
}

function isRunning(detail: OrderDetail): boolean {
  return normalizedExecutionStatus(detail.status) === 'RUNNING';
}

function hasFreshQuery(
  detail: OrderDetail | null,
  queryFresh: boolean,
): detail is OrderDetail & { state: NonNullable<OrderDetail['state']> } {
  return !!detail && queryFresh && !!detail.state && !detail.stateError;
}

function stepIsCompleted(detail: OrderDetail, id: 'inventory' | 'payment'): boolean {
  return detail.state?.steps.some((step) => step.id === id && step.status === 'completed') ?? false;
}

function hasNoRefund(detail: OrderDetail): boolean {
  return detail.payment.refundCount === 0
    && detail.payment.totalRefunded === 0
    && !detail.payment.entries.some((entry) => entry.kind === 'refund');
}

function packOrderActivities(detail: OrderDetail): PendingActivity[] {
  return detail.pendingActivities
    .filter((activity) => activity.activityType === 'packOrder')
    .sort((left, right) => right.attempt - left.attempt);
}

function currentStartedPacking(detail: OrderDetail): PendingActivity | undefined {
  return packOrderActivities(detail)
    .find((activity) => activity.state.toUpperCase() === 'STARTED');
}

function validBaselinePacking(activity: PendingActivity | undefined): activity is PendingActivity & {
  heartbeat: PackingCheckpoint;
} {
  if (!activity?.heartbeat) return false;
  const checkpoint = activity.heartbeat;
  return activity.attempt > 0
    && checkpoint.attempt === activity.attempt
    && checkpoint.completedBatches >= 1
    && checkpoint.totalBatches > checkpoint.completedBatches;
}

function approvalHasAdvanced(detail: OrderDetail): boolean {
  return detail.history.some((event) => (
    (event.type === 'WorkflowExecutionSignaled' && event.signalName === APPROVE_SIGNAL)
    || (event.type.startsWith('WorkflowExecutionUpdate') && event.updateName === APPROVE_UPDATE)
    || (event.type === 'ActivityTaskScheduled' && ['packOrder', 'shipOrder'].includes(event.activityType ?? ''))
    || ['WorkflowExecutionCompleted', 'WorkflowExecutionFailed', 'WorkflowExecutionCanceled',
      'WorkflowExecutionTerminated', 'WorkflowExecutionTimedOut', 'WorkflowExecutionContinuedAsNew'].includes(event.type)
  )) || (hasFreshQuery(detail, true) && (
    detail.state.status !== 'waiting_approval'
    || !!detail.state.approvedAt
    || detail.state.steps.some((step) => step.id === 'approval' && step.status === 'completed')
  ));
}

function observedAfter(observedAt: string, capturedAt: string): boolean {
  const observed = Date.parse(observedAt);
  const captured = Date.parse(capturedAt);
  return Number.isFinite(observed) && Number.isFinite(captured) && observed > captured;
}

function checkpointResumedFromBaseline(
  checkpoint: PackingCheckpoint,
  baseline: PackingCheckpoint,
): boolean {
  return checkpoint.attempt > baseline.attempt
    && checkpoint.resumedFrom > 0
    && checkpoint.resumedFrom >= baseline.completedBatches;
}

function packingObservation(detail: OrderDetail, freshQuery: boolean): PackingObservation {
  const pending = packOrderActivities(detail)[0];
  const finalPacking = freshQuery && detail.state?.packing?.phase === 'completed'
    ? detail.state.packing
    : undefined;
  const latestAttempt = Math.max(pending?.attempt ?? 0, finalPacking?.attempt ?? 0);

  const candidates: PackingCheckpoint[] = [];
  if (
    pending?.state.toUpperCase() === 'STARTED'
    && pending.heartbeat
    && pending.heartbeat.attempt === pending.attempt
  ) {
    candidates.push(pending.heartbeat);
  }
  if (finalPacking) candidates.push(finalPacking);

  const checkpoint = candidates
    .filter((candidate) => candidate.attempt === latestAttempt)
    .sort((left, right) => right.attempt - left.attempt)[0];

  return {
    latestAttempt,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function check(
  id: keyof typeof CHECK_LABELS,
  status: RecoveryCheck['status'],
  detail: string,
): RecoveryCheck {
  return { id, label: CHECK_LABELS[id], status, detail };
}

function modeCheckId(mode: RecoveryMode): 'signal' | 'checkpoint' {
  return mode === 'approval' ? 'signal' : 'checkpoint';
}

function pendingChecks(mode: RecoveryMode, detail: string): RecoveryCheck[] {
  return [
    check('interruption', 'pending', detail),
    check('payment', 'pending', detail),
    check('history', 'pending', detail),
    check(modeCheckId(mode), 'pending', detail),
    check('completion', 'pending', detail),
  ];
}

export function recoveryReadiness(
  mode: RecoveryMode,
  detail: OrderDetail | null,
  queryFresh: boolean,
): { ready: boolean; reason: string } {
  if (!detail) return { ready: false, reason: '尚未取得工作流详情。' };
  if (!hasFreshQuery(detail, queryFresh)) {
    return { ready: false, reason: '需要一次成功且新鲜的 Query 响应。' };
  }
  if (!isRunning(detail)) {
    return { ready: false, reason: 'Describe 必须显示工作流仍为 RUNNING。' };
  }
  if (detail.state.workflowId !== detail.workflowId) {
    return { ready: false, reason: 'Query 与 Describe 返回了不同的工作流身份。' };
  }
  if (!observedAfter(detail.observedAt, '1970-01-01T00:00:00.000Z')) {
    return { ready: false, reason: '响应缺少可用的观测时间。' };
  }
  if (!stepIsCompleted(detail, 'inventory') || !stepIsCompleted(detail, 'payment')) {
    return { ready: false, reason: '库存和付款两个步骤都必须已经完成。' };
  }
  if (
    detail.payment.attempts !== 1
    || detail.payment.debitCount !== 1
    || !hasNoRefund(detail)
  ) {
    return { ready: false, reason: '付款基线必须恰好调用一次、扣款一次且没有退款。' };
  }

  if (mode === 'approval') {
    if (detail.state.input.scenario !== 'normal' || detail.state.status !== 'waiting_approval') {
      return { ready: false, reason: '确认恢复只适用于等待人工确认的 normal 场景。' };
    }
    if (approvalHasAdvanced(detail)) {
      return { ready: false, reason: 'Query 等待确认状态与已存在的确认推进证据不一致。请等待一致响应，或新建订单重做。' };
    }
    return { ready: true, reason: '可以记录等待确认时的恢复基线。' };
  }

  if (detail.state.input.scenario !== 'heartbeat') {
    return { ready: false, reason: '打包恢复只适用于 heartbeat 场景。' };
  }
  const packing = currentStartedPacking(detail);
  if (!validBaselinePacking(packing)) {
    return {
      ready: false,
      reason: '需要 packOrder 当前 attempt 的真实心跳，且至少完成一批、尚未全部完成。',
    };
  }
  return { ready: true, reason: '可以记录打包心跳检查点。' };
}

export function captureRecoveryBaseline(
  mode: RecoveryMode,
  detail: OrderDetail | null,
): RecoveryBaseline {
  const readiness = recoveryReadiness(mode, detail, true);
  if (!readiness.ready || !detail) throw new Error(readiness.reason);

  const completedActivityEventIds = detail.history
    .filter((event) => event.type === 'ActivityTaskCompleted')
    .map((event) => String(event.id));
  const historyEventId = historyBoundary(detail);
  const packingActivity = mode === 'packing' ? currentStartedPacking(detail) : undefined;
  const packing = packingActivity?.heartbeat;

  if (mode === 'packing' && !validBaselinePacking(packingActivity)) {
    throw new Error('打包基线缺少当前 attempt 的有效心跳。');
  }

  return {
    mode,
    workflowId: detail.workflowId,
    runId: detail.runId,
    capturedAt: detail.observedAt,
    historyEventId,
    paymentAttempts: detail.payment.attempts,
    debitCount: detail.payment.debitCount,
    totalCharged: detail.payment.totalCharged,
    completedActivityEventIds: [...completedActivityEventIds],
    ...(packing ? { packing: cloneCheckpoint(packing) } : {}),
  };
}

export function emptyRecoveryEvidence(): RecoveryEvidence {
  return {
    queryInterrupted: false,
    queryRestored: false,
    postBaselineWorkflowTask: false,
  };
}

export function observeRecovery(
  baseline: RecoveryBaseline,
  evidence: RecoveryEvidence,
  detail: OrderDetail,
  phase: 'stopped' | 'restarted',
): RecoveryEvidence {
  const next: RecoveryEvidence = {
    ...evidence,
    ...(evidence.resumedPacking
      ? { resumedPacking: cloneCheckpoint(evidence.resumedPacking) }
      : {}),
  };
  if (
    detail.workflowId !== baseline.workflowId
    || detail.runId !== baseline.runId
    || !observedAfter(detail.observedAt, next.lastObservedAt ?? baseline.capturedAt)
    || historyBoundary(detail) < (next.lastHistoryEventId ?? baseline.historyEventId)
  ) {
    return next;
  }
  next.lastObservedAt = detail.observedAt;
  next.lastHistoryEventId = historyBoundary(detail);

  const freshQuery = !!detail.state && !detail.stateError;
  if (next.invalidReason) return next;
  if (phase === 'stopped' && baseline.mode === 'approval' && !next.queryInterrupted) {
    if (!isRunning(detail) || approvalHasAdvanced(detail)) {
      next.invalidReason = '确认已在有效的停机中断边界建立前推进，无法证明停机窗口 Signal。请清除记录并新建订单重做；先等 Query 中断，再发送 Signal。';
      return next;
    }
  }
  const hadInterruption = next.queryInterrupted
    && next.interruptionHistoryEventId !== undefined
    && !!next.interruptionObservedAt;
  if (phase === 'stopped' && !freshQuery && isRunning(detail) && !hadInterruption) {
    next.queryInterrupted = true;
    next.interruptionHistoryEventId = historyBoundary(detail);
    next.interruptionObservedAt = detail.observedAt;
  }
  if (phase === 'restarted' && freshQuery && hadInterruption) {
    next.queryRestored = true;
  }

  if (baseline.mode === 'approval') {
    if (phase === 'restarted' && !next.signalEventId) {
      next.invalidReason = '重启前未采集到停机窗口 Signal，重启响应不能补认。请清除记录并新建订单重做。';
      return next;
    }
    if (phase === 'stopped' && hadInterruption && !next.signalEventId && freshQuery) {
      next.invalidReason = '停机阶段 Query 已恢复可用，无法继续确认停机窗口。请清除记录并新建订单重做。';
      return next;
    }
    if (phase === 'stopped' && hadInterruption && !next.signalEventId) {
      if (!isRunning(detail)) {
        next.invalidReason = '尚未采集到停机窗口 Signal，执行已结束。请清除记录并新建订单重做。';
        return next;
      }
      const signal = detail.history
        .filter((event) => (
          event.type === 'WorkflowExecutionSignaled'
          && event.signalName === APPROVE_SIGNAL
          && eventId(event) > next.interruptionHistoryEventId!
        ))
        .sort((left, right) => eventId(left) - eventId(right))[0];
      if (signal) next.signalEventId = String(signal.id);
    }
  }

  const taskBoundary = baseline.mode === 'approval'
    ? Number(next.signalEventId)
    : baseline.historyEventId;
  if (detail.history.some((event) => (
    event.type === 'WorkflowTaskCompleted' && eventId(event) > taskBoundary
  ))) {
    next.postBaselineWorkflowTask = true;
  }

  if (phase !== 'restarted' || baseline.mode !== 'packing' || !baseline.packing) {
    return next;
  }

  const observation = packingObservation(detail, freshQuery);
  const priorAttempt = next.resumedPacking?.attempt ?? baseline.packing.attempt;
  const checkpoint = observation.checkpoint;

  if (checkpoint && checkpoint.attempt > baseline.packing.attempt) {
    if (checkpointResumedFromBaseline(checkpoint, baseline.packing)) {
      if (!next.resumedPacking || checkpoint.attempt >= next.resumedPacking.attempt) {
        next.resumedPacking = cloneCheckpoint(checkpoint);
      }
    } else if (!next.resumedPacking || checkpoint.attempt >= next.resumedPacking.attempt) {
      delete next.resumedPacking;
    }
  } else if (observation.latestAttempt > priorAttempt) {
    delete next.resumedPacking;
  }

  return next;
}

export function recoveryPhaseReadiness(
  phase: 'stopped' | 'restarted',
  baseline: RecoveryBaseline,
  evidence: RecoveryEvidence,
  current: OrderDetail | null,
  responseFresh: boolean,
): { ready: boolean; reason: string } {
  if (evidence.invalidReason) return { ready: false, reason: evidence.invalidReason };
  if (!current || !responseFresh) {
    return { ready: false, reason: '需要实验订单的新鲜响应后才能继续。' };
  }
  if (current.workflowId !== baseline.workflowId || current.runId !== baseline.runId) {
    return { ready: false, reason: '响应不属于基线的 Workflow ID / Run ID，请返回本次实验执行。' };
  }
  const currentObservedAt = Date.parse(current.observedAt);
  const latestObservedAt = Date.parse(evidence.lastObservedAt ?? baseline.capturedAt);
  if (!Number.isFinite(currentObservedAt) || !(currentObservedAt >= latestObservedAt)
      || historyBoundary(current) < (evidence.lastHistoryEventId ?? baseline.historyEventId)) {
    return { ready: false, reason: '当前响应早于已记录的观测或 History 已回退，请等待更新响应。' };
  }
  if (!isRunning(current)
      && (phase === 'stopped' || normalizedExecutionStatus(current.status) !== 'COMPLETED')) {
    return { ready: false, reason: `当前执行状态为 ${current.status}，${phase === 'stopped' ? '停止阶段必须仍为 RUNNING' : '重启核对仅接受 RUNNING 或 COMPLETED'}。请清除记录并新建订单重做。` };
  }
  const failedCheck = recoveryChecks(baseline, evidence, current, true, !current.stateError)
    .find((candidate) => candidate.status === 'fail');
  if (failedCheck) return { ready: false, reason: `${failedCheck.detail}请核对 History 或重做实验。` };
  if (phase === 'stopped') {
    if (baseline.mode === 'approval' && approvalHasAdvanced(current)) {
      return { ready: false, reason: '确认已在停机边界建立前推进，不能继续记录停止。请清除记录并新建订单重做。' };
    }
    return { ready: true, reason: '停止 Worker 后记录操作，随后等待新的 Query 中断观测。' };
  }
  if (!evidence.queryInterrupted || evidence.interruptionHistoryEventId === undefined) {
    return { ready: false, reason: '先等待同一 Run 仍为 RUNNING 时的 Query 中断和 History 边界。' };
  }
  if (baseline.mode === 'approval' && signalCheck(baseline, evidence, current).status !== 'pass') {
    return { ready: false, reason: '先等待中断边界之后的 approveOrder 在停机阶段入库，再重启 Worker。' };
  }
  return { ready: true, reason: '停机证据已采集，可在终端重启 Worker，待就绪后记录重启。' };
}

export function transitionRecoveryPhase(
  session: RecoverySession,
  phase: 'stopped' | 'restarted',
  current: OrderDetail | null,
  responseFresh: boolean,
): { session: RecoverySession; ready: boolean; reason: string } {
  const readiness = recoveryPhaseReadiness(phase, session.baseline, session.evidence, current, responseFresh);
  if (!readiness.ready || !current) return { session, ...readiness };
  if (session.phase !== (phase === 'stopped' ? 'captured' : 'stopped')) {
    return { session, ready: false, reason: '请按保存基线、停止、观察、重启的顺序记录实验。' };
  }
  return {
    ...readiness,
    session: { ...session, phase, phaseResponseAt: current.observedAt },
  };
}

function interruptionCheck(evidence: RecoveryEvidence): RecoveryCheck {
  if (evidence.invalidReason) return check('interruption', 'fail', evidence.invalidReason);
  if (evidence.queryInterrupted && evidence.queryRestored) {
    return check('interruption', 'pass', '已观察到 Query 中断，并在重启后由新鲜 Query 恢复。');
  }
  if (evidence.queryInterrupted) {
    return check('interruption', 'pending', '已观察到 Query 中断，尚未观察到恢复。');
  }
  return check('interruption', 'pending', '尚未观察到真实的 Query 中断。');
}

function paymentCheck(baseline: RecoveryBaseline, current: OrderDetail): RecoveryCheck {
  const payment = current.payment;
  if (!hasNoRefund(current)) {
    return check('payment', 'fail', '恢复期间出现了退款。');
  }
  if (
    payment.attempts !== baseline.paymentAttempts
    || payment.debitCount !== baseline.debitCount
    || payment.totalCharged !== baseline.totalCharged
  ) {
    return check('payment', 'fail', '付款调用次数、扣款次数或扣款金额与基线不一致。');
  }
  return check('payment', 'pass', '付款调用、扣款次数和金额均与基线相同，且没有退款。');
}

function protectedPaymentActivity(activityType: string | undefined): boolean {
  const normalized = activityType?.toLowerCase() ?? '';
  return normalized.includes('inventory') || normalized.includes('payment');
}

function historyCheck(
  baseline: RecoveryBaseline,
  evidence: RecoveryEvidence,
  current: OrderDetail,
): RecoveryCheck {
  const ids = new Set(current.history.map((event) => String(event.id)));
  const missing = baseline.completedActivityEventIds.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    return check('history', 'fail', `基线中的已完成 Activity 事件缺失：${missing.join(', ')}。`);
  }

  const repeatedSchedule = current.history.find((event) => (
    event.type === 'ActivityTaskScheduled'
    && eventId(event) > baseline.historyEventId
    && protectedPaymentActivity(event.activityType)
  ));
  if (repeatedSchedule) {
    return check('history', 'fail', `恢复后重新安排了 ${repeatedSchedule.activityType ?? '库存/付款 Activity'}。`);
  }

  const taskBoundary = baseline.mode === 'approval'
    ? Number(evidence.signalEventId)
    : baseline.historyEventId;
  const hasPostBaselineTask = current.history.some((event) => (
    event.type === 'WorkflowTaskCompleted' && eventId(event) > taskBoundary
  ));
  if (!evidence.postBaselineWorkflowTask || !hasPostBaselineTask) {
    return check('history', 'pending', baseline.mode === 'approval'
      ? '尚未观察到已认证的停机窗口 Signal 之后完成的 Workflow Task。'
      : '尚未观察到基线之后完成的 Workflow Task。');
  }
  return check('history', 'pass', '历史连续，库存与付款未重排，且 Workflow Task 已继续推进。');
}

function signalCheck(
  baseline: RecoveryBaseline,
  evidence: RecoveryEvidence,
  current: OrderDetail,
): RecoveryCheck {
  if (evidence.invalidReason) return check('signal', 'fail', evidence.invalidReason);
  if (!evidence.queryInterrupted || evidence.interruptionHistoryEventId === undefined) {
    return check('signal', 'pending', '先等待同一 Run 仍为 RUNNING 时的 Query 中断，建立 History 边界后再发送 Signal。');
  }
  if (!evidence.signalEventId) {
    return check('signal', 'pending', '尚未在停机阶段观察到中断 History 边界之后新增的确认 Signal。');
  }
  const signal = current.history.find((event) => (
    String(event.id) === evidence.signalEventId
    && event.type === 'WorkflowExecutionSignaled'
    && event.signalName === APPROVE_SIGNAL
    && eventId(event) > baseline.historyEventId
    && eventId(event) > evidence.interruptionHistoryEventId!
  ));
  if (!signal) {
    return check('signal', 'fail', '已记录的确认 Signal 无法在当前历史中验证。');
  }
  return check('signal', 'pass', `确认 Signal 已持久化为事件 ${signal.id}。`);
}

function checkpointCheck(
  baseline: RecoveryBaseline,
  evidence: RecoveryEvidence,
  current: OrderDetail,
  freshQuery: boolean,
): RecoveryCheck {
  if (!baseline.packing) {
    return check('checkpoint', 'fail', '打包恢复基线缺少检查点。');
  }

  const observation = packingObservation(current, freshQuery);
  const latest = observation.checkpoint;
  if (
    latest
    && latest.attempt > baseline.packing.attempt
    && !checkpointResumedFromBaseline(latest, baseline.packing)
  ) {
    return check('checkpoint', 'fail', '新的打包 attempt 从零或从早于基线的位置开始。');
  }

  const resumed = evidence.resumedPacking;
  if (!resumed) {
    return check('checkpoint', 'pending', '尚未观察到新 attempt 从基线检查点恢复。');
  }
  if (!checkpointResumedFromBaseline(resumed, baseline.packing)) {
    return check('checkpoint', 'fail', '记录的恢复检查点不满足基线约束。');
  }
  if (observation.latestAttempt > resumed.attempt) {
    return check('checkpoint', 'pending', '已出现更晚的 attempt，但还没有匹配该 attempt 的可靠心跳。');
  }
  if (observation.latestAttempt > 0 && observation.latestAttempt < resumed.attempt) {
    return check('checkpoint', 'pending', '当前响应尚未包含已记录的恢复 attempt。');
  }
  return check(
    'checkpoint',
    'pass',
    `第 ${resumed.attempt} 次尝试从第 ${resumed.resumedFrom} 批继续。`,
  );
}

function completionCheck(current: OrderDetail, freshQuery: boolean): RecoveryCheck {
  const status = normalizedExecutionStatus(current.status);
  if (status === 'COMPLETED') {
    if (freshQuery && current.state?.status === 'completed') {
      return check('completion', 'pass', 'Describe 与新鲜 Query 均确认工作流已完成。');
    }
    return check('completion', 'pending', 'Describe 已完成，但仍缺少状态为 completed 的新鲜 Query。');
  }
  if (['FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW'].includes(status)) {
    return check('completion', 'fail', `工作流以 ${status} 关闭，而不是 COMPLETED。`);
  }
  return check('completion', 'pending', status === 'RUNNING'
    ? '工作流尚未完成。'
    : 'Describe 尚未提供可判定的完成状态。');
}

export function recoveryChecks(
  baseline: RecoveryBaseline,
  evidence: RecoveryEvidence,
  current: OrderDetail | null,
  responseFresh: boolean,
  queryFresh: boolean,
): RecoveryCheck[] {
  const identityMismatch = !!current && (
    current.workflowId !== baseline.workflowId || current.runId !== baseline.runId
  );
  if (identityMismatch) {
    return [
      check('identity', 'fail', '当前响应属于其它 workflow 或 run。'),
      ...pendingChecks(baseline.mode, '工作流身份不一致，不能判定此项。'),
    ];
  }

  if (!current || !responseFresh) {
    return [
      check('identity', 'pending', current ? '当前响应已过期。' : '尚未取得当前响应。'),
      interruptionCheck(evidence),
      check('payment', 'pending', '需要新鲜响应后再核对付款。'),
      check('history', 'pending', '需要新鲜响应后再核对历史。'),
      check(modeCheckId(baseline.mode), 'pending', '需要新鲜响应后再核对恢复证据。'),
      check('completion', 'pending', '需要新鲜响应后再确认完成状态。'),
    ];
  }

  const freshQuery = hasFreshQuery(current, queryFresh);
  return [
    check('identity', 'pass', 'workflowId 与 runId 均匹配基线。'),
    interruptionCheck(evidence),
    paymentCheck(baseline, current),
    historyCheck(baseline, evidence, current),
    baseline.mode === 'approval'
      ? signalCheck(baseline, evidence, current)
      : checkpointCheck(baseline, evidence, current, freshQuery),
    completionCheck(current, freshQuery),
  ];
}
