import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureRecoveryBaseline,
  emptyRecoveryEvidence,
  observeRecovery,
  recoveryChecks,
  recoveryPhaseReadiness,
  recoveryReadiness,
  transitionRecoveryPhase,
  type RecoveryEvidence,
  type RecoverySession,
} from '../src/recovery';
import { APPROVE_SIGNAL } from '../shared/types';
import type {
  HistoryEvent,
  OrderDetail,
  OrderState,
  PackingCheckpoint,
  PaymentLedger,
  PendingActivity,
} from '../shared/types';

const WORKFLOW_ID = 'learning-order-recovery';
const RUN_ID = 'run-recovery';
const CAPTURED_AT = '2026-10-21T10:00:00.000Z';
const OBSERVED_AT = '2026-10-21T10:00:01.000Z';

function historyEvent(
  id: number,
  type: string,
  fields: Partial<HistoryEvent> = {},
): HistoryEvent {
  return {
    id: String(id),
    type,
    timestamp: `2026-10-21T10:00:${String(id).padStart(2, '0')}.000Z`,
    label: type,
    category: type.startsWith('Activity') ? 'activity' : 'workflow',
    ...fields,
  };
}

function baselineHistory(): HistoryEvent[] {
  return [
    historyEvent(2, 'ActivityTaskScheduled', { activityType: 'reserveInventory' }),
    historyEvent(4, 'ActivityTaskCompleted', { activityType: 'reserveInventory' }),
    historyEvent(5, 'ActivityTaskScheduled', { activityType: 'chargePayment' }),
    historyEvent(8, 'ActivityTaskCompleted', { activityType: 'chargePayment' }),
    historyEvent(9, 'WorkflowTaskCompleted'),
  ];
}

function payment(overrides: Partial<PaymentLedger> = {}): PaymentLedger {
  return {
    idempotencyKey: 'payment-key',
    attempts: 1,
    debitCount: 1,
    refundCount: 0,
    totalCharged: 598,
    totalRefunded: 0,
    entries: [
      {
        id: 1,
        kind: 'attempt',
        attempt: 1,
        amount: 598,
        message: 'attempt',
        createdAt: CAPTURED_AT,
      },
      {
        id: 2,
        kind: 'debit',
        attempt: 1,
        amount: 598,
        message: 'debit',
        createdAt: CAPTURED_AT,
      },
    ],
    ...overrides,
  };
}

function packingCheckpoint(
  overrides: Partial<PackingCheckpoint> = {},
): PackingCheckpoint {
  return {
    completedBatches: 2,
    totalBatches: 4,
    attempt: 1,
    resumedFrom: 0,
    phase: 'packing',
    updatedAt: CAPTURED_AT,
    ...overrides,
  };
}

function orderState(
  scenario: OrderState['input']['scenario'],
  status: OrderState['status'],
  packing?: PackingCheckpoint,
): OrderState {
  return {
    workflowId: WORKFLOW_ID,
    input: {
      customerName: '恢复测试',
      productId: 'keyboard',
      quantity: 2,
      scenario,
      approvalTimeoutSeconds: 60,
    },
    status,
    steps: [
      { id: 'inventory', label: '库存', kind: 'Activity', status: 'completed', detail: '' },
      { id: 'payment', label: '付款', kind: 'Activity', status: 'completed', detail: '' },
      {
        id: 'approval',
        label: '确认',
        kind: 'Signal',
        status: status === 'waiting_approval' ? 'waiting' : 'completed',
        detail: '',
      },
      {
        id: 'packing',
        label: '打包',
        kind: 'Activity',
        status: status === 'completed' ? 'completed' : packing ? 'running' : 'pending',
        detail: '',
      },
      {
        id: 'shipping',
        label: '发货',
        kind: 'Activity',
        status: status === 'completed' ? 'completed' : 'pending',
        detail: '',
      },
    ],
    total: 598,
    createdAt: '2026-10-21T09:59:00.000Z',
    updatedAt: CAPTURED_AT,
    ...(packing ? { packing } : {}),
  };
}

interface DetailOptions {
  mode?: 'approval' | 'packing';
  workflowId?: string;
  runId?: string;
  observedAt?: string;
  describeStatus?: string;
  stateStatus?: OrderState['status'];
  scenario?: OrderState['input']['scenario'];
  state?: OrderState | null;
  stateError?: string;
  history?: HistoryEvent[];
  pendingActivities?: PendingActivity[];
  payment?: PaymentLedger;
  packing?: PackingCheckpoint;
}

function detail(options: DetailOptions = {}): OrderDetail {
  const mode = options.mode ?? 'approval';
  const scenario = options.scenario ?? (mode === 'packing' ? 'heartbeat' : 'normal');
  const stateStatus = options.stateStatus ?? (mode === 'packing' ? 'running' : 'waiting_approval');
  const packing = options.packing ?? (mode === 'packing' ? packingCheckpoint() : undefined);
  const defaultPending = mode === 'packing'
    ? [{
      activityId: 'pack-1',
      activityType: 'packOrder',
      state: 'STARTED',
      attempt: packing?.attempt ?? 1,
      heartbeat: packing,
    }]
    : [];
  const generatedState = orderState(scenario, stateStatus, packing);
  if (options.workflowId) generatedState.workflowId = options.workflowId;

  return {
    workflowId: options.workflowId ?? WORKFLOW_ID,
    runId: options.runId ?? RUN_ID,
    status: options.describeStatus ?? 'RUNNING',
    state: options.state === undefined ? generatedState : options.state,
    ...(options.stateError ? { stateError: options.stateError } : {}),
    history: options.history ?? baselineHistory(),
    observedAt: options.observedAt ?? CAPTURED_AT,
    pendingActivities: options.pendingActivities ?? defaultPending,
    payment: options.payment ?? payment(),
  };
}

function stoppedDetail(mode: 'approval' | 'packing'): OrderDetail {
  return detail({
    mode,
    observedAt: OBSERVED_AT,
    state: null,
    stateError: 'Query unavailable while worker is stopped',
  });
}

function approvalCompletedDetail(overrides: DetailOptions = {}): OrderDetail {
  return detail({
    observedAt: '2026-10-21T10:00:02.000Z',
    describeStatus: 'COMPLETED',
    stateStatus: 'completed',
    history: [
      ...baselineHistory(),
      historyEvent(10, 'WorkflowExecutionSignaled', {
        category: 'signal',
        signalName: APPROVE_SIGNAL,
      }),
      historyEvent(11, 'WorkflowTaskCompleted'),
    ],
    ...overrides,
  });
}

function observeInterruption(
  mode: 'approval' | 'packing',
  baseline: ReturnType<typeof captureRecoveryBaseline>,
): RecoveryEvidence {
  return observeRecovery(baseline, emptyRecoveryEvidence(), stoppedDetail(mode), 'stopped');
}

function byId(checks: ReturnType<typeof recoveryChecks>, id: string) {
  const result = checks.find((candidate) => candidate.id === id);
  assert.ok(result, `missing check ${id}`);
  return result;
}

test('approval 恢复只在严格合格的等待确认快照上捕获深拷贝基线', () => {
  const source = detail();
  assert.deepEqual(recoveryReadiness('approval', source, true), {
    ready: true,
    reason: '可以记录等待确认时的恢复基线。',
  });

  const baseline = captureRecoveryBaseline('approval', source);
  assert.deepEqual(baseline.completedActivityEventIds, ['4', '8']);
  assert.equal(baseline.historyEventId, 9);

  source.history[1].id = 'changed';
  assert.deepEqual(baseline.completedActivityEventIds, ['4', '8']);

  assert.equal(recoveryReadiness('approval', detail(), false).ready, false);
  assert.equal(recoveryReadiness('approval', detail({ describeStatus: 'FAILED' }), true).ready, false);
  assert.equal(recoveryReadiness('approval', detail({ payment: payment({ attempts: 2 }) }), true).ready, false);
  assert.throws(
    () => captureRecoveryBaseline('approval', detail({ scenario: 'retry' })),
    /normal/,
  );
});

test('approval 基线拒绝 waiting Query 与确认推进证据矛盾的快照', () => {
  const approvedState = orderState('normal', 'waiting_approval');
  approvedState.approvedAt = OBSERVED_AT;
  const completedApprovalState = orderState('normal', 'waiting_approval');
  completedApprovalState.steps.find((step) => step.id === 'approval')!.status = 'completed';
  const conflictingDetails = [
    ...[
      historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL }),
      historyEvent(10, 'WorkflowExecutionUpdateAccepted', { updateName: 'approveOrderUpdate' }),
      historyEvent(10, 'WorkflowExecutionUpdateCompleted', { updateName: 'approveOrderUpdate' }),
      historyEvent(10, 'ActivityTaskScheduled', { activityType: 'packOrder' }),
      historyEvent(10, 'ActivityTaskScheduled', { activityType: 'shipOrder' }),
      ...['WorkflowExecutionCompleted', 'WorkflowExecutionFailed', 'WorkflowExecutionCanceled',
        'WorkflowExecutionTerminated', 'WorkflowExecutionTimedOut', 'WorkflowExecutionContinuedAsNew']
        .map((type) => historyEvent(10, type)),
    ].map((event) => detail({ history: [...baselineHistory(), event] })),
    detail({ state: approvedState }),
    detail({ state: completedApprovalState }),
  ];
  for (const source of conflictingDetails) {
    const readiness = recoveryReadiness('approval', source, true);
    assert.equal(readiness.ready, false, 'waiting_approval 不能覆盖确认推进证据');
    assert.match(readiness.reason, /一致|重做/);
    assert.throws(() => captureRecoveryBaseline('approval', source), /一致|重做/);
  }
});

test('packing 恢复要求 heartbeat 场景、STARTED 活动和当前 attempt 的部分进度心跳', () => {
  const source = detail({ mode: 'packing' });
  assert.equal(recoveryReadiness('packing', source, true).ready, true);
  const baseline = captureRecoveryBaseline('packing', source);
  assert.deepEqual(baseline.packing, packingCheckpoint());

  source.pendingActivities[0].heartbeat!.completedBatches = 3;
  assert.equal(baseline.packing?.completedBatches, 2);

  assert.equal(recoveryReadiness('packing', detail({
    mode: 'packing',
    scenario: 'heartbeat_timeout',
  }), true).ready, false);
  assert.equal(recoveryReadiness('packing', detail({
    mode: 'packing',
    pendingActivities: [{
      activityId: 'pack-2',
      activityType: 'packOrder',
      state: 'STARTED',
      attempt: 2,
      heartbeat: packingCheckpoint({ attempt: 1 }),
    }],
  }), true).ready, false);
  assert.equal(recoveryReadiness('packing', detail({
    mode: 'packing',
    packing: packingCheckpoint({ completedBatches: 4 }),
  }), true).ready, false);
});

test('approval 在 Worker 停止前已完成时不能把后续 Query 失败当作恢复成功', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const completed = approvalCompletedDetail();
  let evidence = observeRecovery(baseline, emptyRecoveryEvidence(), completed, 'stopped');
  evidence = observeRecovery(baseline, evidence, approvalCompletedDetail({
    observedAt: '2026-10-21T10:00:03.000Z',
    state: null,
    stateError: 'Worker 已停止，但订单此前已完成',
  }), 'stopped');
  const restarted = approvalCompletedDetail({ observedAt: '2026-10-21T10:00:04.000Z' });
  evidence = observeRecovery(baseline, evidence, restarted, 'restarted');

  const checks = recoveryChecks(baseline, evidence, restarted, true, true);
  assert.equal(checks.every((candidate) => candidate.status === 'pass'), false);
  assert.equal(evidence.queryInterrupted, false);
  assert.equal(byId(checks, 'signal').status, 'fail');
  assert.match(byId(checks, 'signal').detail, /重做/);
});

test('approval 合法停止、中断、Signal 入库、重启后形成完整证据', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const interrupted = stoppedDetail('approval');
  interrupted.history.push(historyEvent(10, 'WorkflowTaskTimedOut'));
  let evidence = observeRecovery(baseline, emptyRecoveryEvidence(), interrupted, 'stopped');
  const signaled = detail({
    observedAt: '2026-10-21T10:00:02.000Z',
    state: null,
    stateError: 'Query unavailable while worker is stopped',
    history: [...interrupted.history, historyEvent(11, 'WorkflowExecutionSignaled', {
      category: 'signal', signalName: APPROVE_SIGNAL,
    })],
  });
  evidence = observeRecovery(baseline, evidence, signaled, 'stopped');
  assert.equal(evidence.signalEventId, '11');
  const completed = approvalCompletedDetail({
    observedAt: '2026-10-21T10:00:03.000Z',
    history: [...signaled.history, historyEvent(12, 'WorkflowTaskCompleted')],
  });
  evidence = observeRecovery(baseline, evidence, completed, 'restarted');

  assert.equal(evidence.queryInterrupted, true);
  assert.equal(evidence.queryRestored, true);
  assert.equal(evidence.signalEventId, '11');
  assert.equal(evidence.postBaselineWorkflowTask, true);
  assert.equal(evidence.interruptionHistoryEventId, 10);
  assert.equal(evidence.interruptionObservedAt, OBSERVED_AT);
  const checks = recoveryChecks(baseline, evidence, completed, true, true);
  assert.ok(checks.every((candidate) => candidate.status === 'pass'));
});

test('approval 中断首次响应已经含 Signal 时拒绝推断停机窗口', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const ambiguous = approvalCompletedDetail({
    describeStatus: 'RUNNING',
    state: null,
    stateError: 'Query unavailable',
    history: [
      ...baselineHistory(),
      historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL }),
    ],
  });
  let evidence = observeRecovery(baseline, emptyRecoveryEvidence(), ambiguous, 'stopped');
  assert.equal(evidence.queryInterrupted, false);
  assert.equal(evidence.signalEventId, undefined);
  assert.equal(evidence.interruptionHistoryEventId, undefined);
  assert.match(evidence.invalidReason ?? '', /重做/);

  const completed = approvalCompletedDetail({ observedAt: '2026-10-21T10:00:03.000Z' });
  evidence = observeRecovery(baseline, evidence, completed, 'restarted');
  assert.equal(byId(recoveryChecks(baseline, evidence, completed, true, true), 'signal').status, 'fail');
});

test('Query 等待期间入库的 Signal 已在首个失败响应 History 中时要求重做且不认证', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  // API 在 Query 失败后读取 History，因此等待期间入库的 Signal 已包含在首个失败响应里。
  const firstFailedResponse = {
    ...stoppedDetail('approval'),
    observedAt: '2026-10-21T10:00:06.000Z',
    history: [...baselineHistory(), historyEvent(10, 'WorkflowExecutionSignaled', {
      signalName: APPROVE_SIGNAL,
      timestamp: '2026-10-21T10:00:03.000Z',
    })],
  };
  let evidence = observeRecovery(baseline, emptyRecoveryEvidence(), firstFailedResponse, 'stopped');
  assert.equal(evidence.queryInterrupted, false);
  assert.equal(evidence.interruptionHistoryEventId, undefined);
  assert.equal(evidence.signalEventId, undefined);
  assert.match(evidence.invalidReason ?? '', /重做/);

  const nextResponse = { ...firstFailedResponse, observedAt: '2026-10-21T10:00:07.000Z' };
  evidence = observeRecovery(baseline, evidence, nextResponse, 'stopped');
  assert.equal(evidence.signalEventId, undefined, '下一次响应也不能把该 Signal 补认为停机窗口证据');
  assert.equal(recoveryPhaseReadiness('restarted', baseline, evidence, nextResponse, true).ready, false);
  assert.equal(byId(recoveryChecks(baseline, evidence, nextResponse, true, false), 'signal').status, 'fail');
});

test('approval 的 Signal 到重启响应才首次出现时不能补出停机证据', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  let evidence = observeInterruption('approval', baseline);
  const completed = approvalCompletedDetail();
  evidence = observeRecovery(baseline, evidence, completed, 'restarted');

  assert.equal(evidence.signalEventId, undefined);
  assert.equal(evidence.postBaselineWorkflowTask, false);
  const checks = recoveryChecks(baseline, evidence, completed, true, true);
  assert.notEqual(byId(checks, 'signal').status, 'pass');
  assert.notEqual(byId(checks, 'history').status, 'pass');
  assert.match(byId(checks, 'signal').detail, /重做/);
});

test('approval 只认证 Query 持续不可用时新增的 Signal，Query 已恢复则要求重做', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  let evidence = observeInterruption('approval', baseline);
  const advanced = approvalCompletedDetail({ describeStatus: 'RUNNING', stateStatus: 'running' });
  evidence = observeRecovery(baseline, evidence, advanced, 'stopped');

  assert.equal(evidence.signalEventId, undefined);
  assert.match(evidence.invalidReason ?? '', /重做/);
});

test('approval 认证的第一个 Signal 不被后续重复 Signal 替换，Task 必须在它之后', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  let evidence = observeInterruption('approval', baseline);
  const signaled = detail({
    observedAt: '2026-10-21T10:00:02.000Z',
    state: null,
    stateError: 'Query unavailable',
    history: [
      ...baselineHistory(),
      historyEvent(10, 'WorkflowTaskCompleted'),
      historyEvent(11, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL }),
    ],
  });
  evidence = observeRecovery(baseline, evidence, signaled, 'stopped');
  assert.equal(evidence.signalEventId, '11');
  assert.equal(evidence.postBaselineWorkflowTask, false);
  assert.equal(byId(recoveryChecks(baseline, evidence, signaled, true, false), 'history').status, 'pending');

  const duplicate = detail({
    observedAt: '2026-10-21T10:00:03.000Z',
    state: null,
    stateError: 'Query unavailable',
    history: [...signaled.history, historyEvent(12, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL })],
  });
  evidence = observeRecovery(baseline, evidence, duplicate, 'stopped');
  assert.equal(evidence.signalEventId, '11');
  const completed = approvalCompletedDetail({
    observedAt: '2026-10-21T10:00:04.000Z',
    history: [...duplicate.history, historyEvent(13, 'WorkflowTaskCompleted')],
  });
  evidence = observeRecovery(baseline, evidence, completed, 'restarted');
  assert.equal(evidence.signalEventId, '11');
  assert.ok(recoveryChecks(baseline, evidence, completed, true, true)
    .every((candidate) => candidate.status === 'pass'));
});

test('approval 初次中断有已接受的确认 Update 或发货调度时不能建立等待确认边界', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  for (const advanced of [
    historyEvent(10, 'WorkflowExecutionUpdateAccepted', { updateName: 'approveOrderUpdate' }),
    historyEvent(10, 'ActivityTaskScheduled', { activityType: 'shipOrder' }),
    historyEvent(10, 'WorkflowExecutionCompleted'),
  ]) {
    const evidence = observeRecovery(baseline, emptyRecoveryEvidence(), detail({
      observedAt: OBSERVED_AT,
      state: null,
      stateError: 'Query unavailable',
      history: [...baselineHistory(), advanced],
    }), 'stopped');
    assert.equal(evidence.queryInterrupted, false);
    assert.equal(evidence.interruptionHistoryEventId, undefined);
    assert.match(evidence.invalidReason ?? '', /重做/);
  }
});

test('停机新旧响应倒序、History 回退或其它 Run 不会污染已认证证据', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const interrupted = stoppedDetail('approval');
  interrupted.observedAt = '2026-10-21T10:00:03.000Z';
  const original = observeRecovery(baseline, emptyRecoveryEvidence(), interrupted, 'stopped');
  const older = approvalCompletedDetail({ describeStatus: 'RUNNING' });
  assert.deepEqual(observeRecovery(baseline, original, older, 'stopped'), original);
  assert.deepEqual(observeRecovery(baseline, original, {
    ...older, observedAt: '2026-10-21T10:00:04.000Z', runId: 'other-run',
  }, 'stopped'), original);
  assert.deepEqual(observeRecovery(baseline, original, {
    ...older, observedAt: '2026-10-21T10:00:04.000Z', history: baselineHistory().slice(0, -1),
  }, 'stopped'), original);
});

test('停机 Signal 已认证后重启提前返回 Query 不会撤销证据或替换 Signal', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  let evidence = observeInterruption('approval', baseline);
  const signaled = detail({
    observedAt: '2026-10-21T10:00:02.000Z', state: null, stateError: 'Query unavailable',
    history: [...baselineHistory(), historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL })],
  });
  evidence = observeRecovery(baseline, evidence, signaled, 'stopped');
  const restored = approvalCompletedDetail({ observedAt: '2026-10-21T10:00:03.000Z' });
  evidence = observeRecovery(baseline, evidence, restored, 'stopped');
  assert.equal(evidence.invalidReason, undefined);
  assert.equal(evidence.signalEventId, '10');
  evidence = observeRecovery(baseline, evidence, {
    ...restored, observedAt: '2026-10-21T10:00:04.000Z',
  }, 'restarted');
  assert.ok(recoveryChecks(baseline, evidence, restored, true, true)
    .every((candidate) => candidate.status === 'pass'));
});

test('停机 Signal 已认证、重启按钮点击前已完成时仍能进入核对并采集后续恢复证据', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const captured: RecoverySession = {
    baseline, phase: 'captured', phaseResponseAt: CAPTURED_AT, evidence: emptyRecoveryEvidence(),
  };
  const stopped = transitionRecoveryPhase(captured, 'stopped', detail(), true);
  assert.equal(stopped.ready, true);
  const interrupted = stoppedDetail('approval');
  const interruption = observeRecovery(baseline, stopped.session.evidence, interrupted, 'stopped');
  const signaled = detail({
    observedAt: '2026-10-21T10:00:02.000Z', state: null, stateError: 'Query unavailable',
    history: [...interrupted.history, historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL })],
  });
  const certified = observeRecovery(baseline, interruption, signaled, 'stopped');
  assert.equal(certified.signalEventId, '10');
  const completed = approvalCompletedDetail({ observedAt: '2026-10-21T10:00:03.000Z' });
  const beforeClick: RecoverySession = {
    ...stopped.session, evidence: observeRecovery(baseline, certified, completed, 'stopped'),
  };
  const restarted = transitionRecoveryPhase(beforeClick, 'restarted', completed, true);
  assert.equal(restarted.ready, true);
  assert.equal(restarted.session.phase, 'restarted');
  assert.equal(restarted.session.phaseResponseAt, completed.observedAt);
  assert.equal(restarted.session.evidence.queryRestored, false, '点击仍不能直接认证 Query 恢复');
  const nextResponse = { ...completed, observedAt: '2026-10-21T10:00:04.000Z' };
  const restored = observeRecovery(baseline, restarted.session.evidence, nextResponse, 'restarted');
  assert.ok(recoveryChecks(baseline, restored, nextResponse, true, true)
    .every((candidate) => candidate.status === 'pass'));
});

test('Describe 仍为 RUNNING 但确认已推进时，停止按钮要求重做而非继续', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  for (const advanced of [
    approvalCompletedDetail({ describeStatus: 'RUNNING' }),
    detail({
      observedAt: OBSERVED_AT,
      history: [...baselineHistory(), historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL })],
    }),
    detail({
      observedAt: OBSERVED_AT,
      state: null, stateError: 'Query unavailable',
      history: [...baselineHistory(), historyEvent(10, 'ActivityTaskScheduled', { activityType: 'shipOrder' })],
    }),
  ]) {
    const readiness = recoveryPhaseReadiness('stopped', baseline, emptyRecoveryEvidence(), advanced, true);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /重做/);
  }
});

test('手工把确认推进事件纳入基线也不能通过停止 transition 或建立中断边界', () => {
  const baseline = { ...captureRecoveryBaseline('approval', detail()), historyEventId: 10 };
  const captured: RecoverySession = {
    baseline, phase: 'captured', phaseResponseAt: CAPTURED_AT, evidence: emptyRecoveryEvidence(),
  };
  for (const advanced of [
    historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL }),
    historyEvent(10, 'WorkflowExecutionUpdateAccepted', { updateName: 'approveOrderUpdate' }),
    historyEvent(10, 'ActivityTaskScheduled', { activityType: 'shipOrder' }),
    historyEvent(10, 'WorkflowExecutionCompleted'),
  ]) {
    const current = detail({ observedAt: OBSERVED_AT, history: [...baselineHistory(), advanced] });
    const stopped = transitionRecoveryPhase(captured, 'stopped', current, true);
    assert.equal(stopped.ready, false, advanced.type);
    assert.equal(stopped.session.phase, 'captured');
    assert.match(stopped.reason, /重做/);

    const interrupted = { ...current, state: null, stateError: 'Query unavailable' };
    const evidence = observeRecovery(baseline, captured.evidence, interrupted, 'stopped');
    assert.equal(evidence.queryInterrupted, false, '绕过阶段记录也不能使用已含确认推进事件的基线');
    assert.equal(evidence.signalEventId, undefined);
    assert.match(evidence.invalidReason ?? '', /重做/);
  }
});

test('重启允许已有窗口证据的完成响应，仍拦截提前完成、其它终态、身份和账本历史错误', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const empty = emptyRecoveryEvidence();
  const completed = approvalCompletedDetail();
  assert.equal(recoveryPhaseReadiness('stopped', baseline, empty, detail(), true).ready, true);
  assert.equal(recoveryPhaseReadiness('stopped', baseline, empty, completed, true).ready, false);
  assert.equal(recoveryPhaseReadiness('stopped', baseline, empty, detail({ runId: 'other-run' }), true).ready, false);
  assert.equal(recoveryPhaseReadiness('stopped', baseline, empty, detail(), false).ready, false);
  assert.equal(recoveryPhaseReadiness('restarted', baseline, empty, detail(), true).ready, false);
  assert.equal(recoveryPhaseReadiness('restarted', baseline, empty, completed, true).ready, false);

  let evidence = observeInterruption('approval', baseline);
  assert.equal(recoveryPhaseReadiness('restarted', baseline, evidence, completed, true).ready, false,
    '未认证 Signal 的完成响应不能补认停机窗口');
  const signaled = detail({
    observedAt: '2026-10-21T10:00:02.000Z',
    state: null, stateError: 'Query unavailable',
    history: [...baselineHistory(), historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL })],
  });
  evidence = observeRecovery(baseline, evidence, signaled, 'stopped');
  assert.equal(recoveryPhaseReadiness('restarted', baseline, evidence, signaled, true).ready, true);
  assert.equal(recoveryPhaseReadiness('restarted', baseline, evidence, completed, true).ready, true);
  assert.equal(recoveryPhaseReadiness('stopped', baseline, evidence, completed, true).ready, false);
  assert.equal(recoveryPhaseReadiness('restarted', baseline, evidence, completed, false).ready, false);
  for (const status of ['FAILED', 'CANCELED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW', 'UNSPECIFIED']) {
    assert.equal(recoveryPhaseReadiness('restarted', baseline, evidence, { ...completed, status }, true).ready, false, status);
  }
  for (const rejected of [
    { current: { ...completed, runId: 'other-run' }, reason: /Workflow ID \/ Run ID/ },
    { current: { ...completed, workflowId: 'other-workflow' }, reason: /Workflow ID \/ Run ID/ },
    { current: { ...completed, payment: payment({ attempts: 2 }) }, reason: /付款/ },
    { current: { ...completed, payment: payment({ refundCount: 1, totalRefunded: 598 }) }, reason: /退款/ },
    { current: { ...completed, history: completed.history.filter((event) => event.id !== '4') }, reason: /已完成 Activity/ },
    { current: { ...completed, history: completed.history.filter((event) => event.id !== '10') }, reason: /Signal/ },
    { current: {
      ...completed,
      history: [...completed.history, historyEvent(12, 'ActivityTaskScheduled', { activityType: 'chargePayment' })],
    }, reason: /重新安排/ },
  ]) {
    const readiness = recoveryPhaseReadiness('restarted', baseline, evidence, rejected.current, true);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, rejected.reason);
  }
  const invalid = recoveryPhaseReadiness('restarted', baseline, { ...evidence, invalidReason: '请重做实验' }, completed, true);
  assert.equal(invalid.ready, false);
  assert.match(invalid.reason, /重做/);
});

test('阶段按钮拒绝已完成、过期、错 Run 和缺少证据的继续，并只使用服务端响应边界', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const session: RecoverySession = {
    baseline, phase: 'captured', phaseResponseAt: CAPTURED_AT, evidence: emptyRecoveryEvidence(),
  };
  const completed = approvalCompletedDetail();
  const rejected = transitionRecoveryPhase(session, 'stopped', completed, true);
  assert.equal(rejected.session.phase, 'captured');
  assert.match(rejected.reason, /重做/);
  assert.equal(transitionRecoveryPhase(session, 'stopped', detail(), false).session.phase, 'captured');
  assert.equal(transitionRecoveryPhase(session, 'stopped', detail({ runId: 'other-run' }), true).session.phase, 'captured');

  const stopped = transitionRecoveryPhase(session, 'stopped', detail(), true);
  assert.equal(stopped.ready, true);
  assert.equal(stopped.session.phase, 'stopped');
  assert.equal(stopped.session.phaseResponseAt, CAPTURED_AT);
  assert.equal(stopped.session.evidence.queryInterrupted, false);
  const interrupted = stoppedDetail('approval');
  const observed: RecoverySession = {
    ...stopped.session,
    evidence: observeRecovery(baseline, stopped.session.evidence, interrupted, 'stopped'),
  };
  assert.equal(transitionRecoveryPhase(observed, 'restarted', interrupted, true).session.phase, 'stopped');
  const invalid = transitionRecoveryPhase({
    ...observed, evidence: { ...observed.evidence, invalidReason: '证据错误，请重做。' },
  }, 'restarted', interrupted, true);
  assert.equal(invalid.ready, false);
  assert.match(invalid.reason, /重做/);

  const signaled = detail({
    observedAt: '2026-10-21T10:00:02.000Z', state: null, stateError: 'Query unavailable',
    history: [...baselineHistory(), historyEvent(10, 'WorkflowExecutionSignaled', { signalName: APPROVE_SIGNAL })],
  });
  const certified: RecoverySession = {
    ...observed, evidence: observeRecovery(baseline, observed.evidence, signaled, 'stopped'),
  };
  const restarted = transitionRecoveryPhase(certified, 'restarted', signaled, true);
  assert.equal(restarted.ready, true);
  assert.equal(restarted.session.phase, 'restarted');
  assert.equal(restarted.session.phaseResponseAt, signaled.observedAt);
  assert.equal(restarted.session.evidence.queryRestored, false);
});

test('旧响应或回退的 History 不能解锁阶段按钮', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const interrupted = stoppedDetail('approval');
  interrupted.observedAt = '2026-10-21T10:00:03.000Z';
  const evidence = observeRecovery(baseline, emptyRecoveryEvidence(), interrupted, 'stopped');
  const stale = recoveryPhaseReadiness('stopped', baseline, evidence, detail({
    observedAt: '2026-10-21T10:00:02.000Z',
  }), true);
  assert.equal(stale.ready, false);
  assert.match(stale.reason, /早于|过期/);
  const regressed = recoveryPhaseReadiness('stopped', baseline, evidence, detail({
    observedAt: '2026-10-21T10:00:04.000Z', history: baselineHistory().slice(0, -1),
  }), true);
  assert.equal(regressed.ready, false);
});

test('packing 在重启按钮前已完成时允许核对，后续新鲜 Query 证明从基线检查点恢复', () => {
  const baseline = captureRecoveryBaseline('packing', detail({ mode: 'packing' }));
  const interrupted = stoppedDetail('packing');
  const stopped: RecoverySession = {
    baseline, phase: 'stopped', phaseResponseAt: CAPTURED_AT,
    evidence: observeInterruption('packing', baseline),
  };
  const resumed = packingCheckpoint({
    completedBatches: 4,
    attempt: 2,
    resumedFrom: 2,
    phase: 'completed',
    updatedAt: '2026-10-21T10:00:02.000Z',
  });
  const completed = detail({
    mode: 'packing',
    observedAt: '2026-10-21T10:00:02.000Z',
    describeStatus: 'COMPLETED',
    stateStatus: 'completed',
    packing: resumed,
    pendingActivities: [],
    history: [...interrupted.history, historyEvent(10, 'WorkflowTaskCompleted')],
  });
  assert.equal(transitionRecoveryPhase({ ...stopped, evidence: emptyRecoveryEvidence() }, 'restarted', completed, true).ready, false,
    '打包完成也不能替代真实的停机中断');
  assert.equal(transitionRecoveryPhase(stopped, 'stopped', completed, true).ready, false);
  const beforeClick = { ...stopped, evidence: observeRecovery(baseline, stopped.evidence, completed, 'stopped') };
  const restarted = transitionRecoveryPhase(beforeClick, 'restarted', completed, true);
  assert.equal(restarted.ready, true);
  assert.equal(restarted.session.phase, 'restarted');
  assert.equal(restarted.session.evidence.queryRestored, false);
  assert.equal(restarted.session.evidence.resumedPacking, undefined);
  const nextResponse = { ...completed, observedAt: '2026-10-21T10:00:03.000Z' };
  const evidence = observeRecovery(baseline, restarted.session.evidence, nextResponse, 'restarted');

  assert.deepEqual(evidence.resumedPacking, resumed);
  const checks = recoveryChecks(baseline, evidence, nextResponse, true, true);
  assert.ok(checks.every((candidate) => candidate.status === 'pass'));
});

test('只点击重启按钮、没有真实 Query 中断时不能通过 interruption', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const completed = approvalCompletedDetail();
  const evidence = observeRecovery(
    baseline,
    emptyRecoveryEvidence(),
    completed,
    'restarted',
  );

  assert.equal(evidence.queryInterrupted, false);
  assert.equal(evidence.queryRestored, false);
  const interruption = byId(recoveryChecks(baseline, evidence, completed, true, true), 'interruption');
  assert.equal(interruption.status, 'fail');
  assert.match(interruption.detail, /重做/);
});

test('同一快照和其它 run 的响应不会产生任何恢复证据', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const original = emptyRecoveryEvidence();
  const sameSnapshot = approvalCompletedDetail({ observedAt: CAPTURED_AT });
  const otherRun = approvalCompletedDetail({ runId: 'other-run' });

  assert.deepEqual(observeRecovery(baseline, original, sameSnapshot, 'restarted'), original);
  assert.deepEqual(observeRecovery(baseline, original, otherRun, 'stopped'), original);

  const checks = recoveryChecks(baseline, original, otherRun, true, true);
  assert.equal(byId(checks, 'identity').status, 'fail');
  assert.ok(checks.filter((candidate) => candidate.id !== 'identity')
    .every((candidate) => candidate.status !== 'pass'));
});

test('过期响应不会让动态检查通过，但保留已观察到的 interruption 事实', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  let evidence = observeInterruption('approval', baseline);
  const signaled = approvalCompletedDetail({
    describeStatus: 'RUNNING', state: null, stateError: 'Query unavailable',
  });
  evidence = observeRecovery(baseline, evidence, signaled, 'stopped');
  const completed = approvalCompletedDetail({ observedAt: '2026-10-21T10:00:03.000Z' });
  evidence = observeRecovery(baseline, evidence, completed, 'restarted');

  const checks = recoveryChecks(baseline, evidence, completed, false, true);
  assert.equal(byId(checks, 'identity').status, 'pending');
  assert.equal(byId(checks, 'interruption').status, 'pass');
  assert.ok(checks.filter((candidate) => !['identity', 'interruption'].includes(candidate.id))
    .every((candidate) => candidate.status === 'pending'));
});

test('attempt 已增加但 heartbeat 仍属于旧 attempt 时不得视为恢复', () => {
  const baseline = captureRecoveryBaseline('packing', detail({ mode: 'packing' }));
  const current = detail({
    mode: 'packing',
    observedAt: '2026-10-21T10:00:02.000Z',
    pendingActivities: [{
      activityId: 'pack-2',
      activityType: 'packOrder',
      state: 'STARTED',
      attempt: 2,
      heartbeat: packingCheckpoint({ attempt: 1, resumedFrom: 2 }),
    }],
    history: [...baselineHistory(), historyEvent(10, 'WorkflowTaskCompleted')],
  });
  let evidence = observeInterruption('packing', baseline);
  evidence = observeRecovery(baseline, evidence, current, 'restarted');

  assert.equal(evidence.resumedPacking, undefined);
  assert.equal(byId(recoveryChecks(baseline, evidence, current, true, true), 'checkpoint').status, 'pending');
});

test('更晚 attempt 从 0 开始会撤销旧候选并明确失败', () => {
  const baseline = captureRecoveryBaseline('packing', detail({ mode: 'packing' }));
  let evidence = observeInterruption('packing', baseline);
  const successfulAttempt = detail({
    mode: 'packing',
    observedAt: '2026-10-21T10:00:02.000Z',
    packing: packingCheckpoint({ attempt: 2, resumedFrom: 2, completedBatches: 3 }),
    pendingActivities: [{
      activityId: 'pack-2',
      activityType: 'packOrder',
      state: 'STARTED',
      attempt: 2,
      heartbeat: packingCheckpoint({ attempt: 2, resumedFrom: 2, completedBatches: 3 }),
    }],
    history: [...baselineHistory(), historyEvent(10, 'WorkflowTaskCompleted')],
  });
  evidence = observeRecovery(baseline, evidence, successfulAttempt, 'restarted');
  assert.equal(evidence.resumedPacking?.attempt, 2);

  const restartedFromZero = detail({
    mode: 'packing',
    observedAt: '2026-10-21T10:00:03.000Z',
    packing: packingCheckpoint({ attempt: 3, resumedFrom: 0, completedBatches: 1 }),
    pendingActivities: [{
      activityId: 'pack-3',
      activityType: 'packOrder',
      state: 'STARTED',
      attempt: 3,
      heartbeat: packingCheckpoint({ attempt: 3, resumedFrom: 0, completedBatches: 1 }),
    }],
    history: [...baselineHistory(), historyEvent(10, 'WorkflowTaskCompleted')],
  });
  evidence = observeRecovery(baseline, evidence, restartedFromZero, 'restarted');

  assert.equal(evidence.resumedPacking, undefined);
  assert.equal(
    byId(recoveryChecks(baseline, evidence, restartedFromZero, true, true), 'checkpoint').status,
    'fail',
  );
});

test('付款 attempt 增加、重复扣款或退款都会失败', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const evidence = { ...emptyRecoveryEvidence(), queryInterrupted: true, queryRestored: true };
  for (const changedPayment of [
    payment({ attempts: 2 }),
    payment({ debitCount: 2, totalCharged: 1196 }),
    payment({ refundCount: 1, totalRefunded: 598 }),
  ]) {
    const current = approvalCompletedDetail({ payment: changedPayment });
    assert.equal(
      byId(recoveryChecks(baseline, evidence, current, true, true), 'payment').status,
      'fail',
    );
  }
});

test('恢复后重新 schedule 库存或付款 Activity 会让 history 失败', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const current = approvalCompletedDetail({
    history: [
      ...baselineHistory(),
      historyEvent(10, 'ActivityTaskScheduled', { activityType: 'chargePayment' }),
      historyEvent(11, 'WorkflowTaskCompleted'),
    ],
  });
  const evidence: RecoveryEvidence = {
    queryInterrupted: true,
    queryRestored: true,
    postBaselineWorkflowTask: true,
  };

  assert.equal(byId(recoveryChecks(baseline, evidence, current, true, true), 'history').status, 'fail');
});

test('失败关闭明确 fail；仍运行或缺少证据保持 pending', () => {
  const baseline = captureRecoveryBaseline('approval', detail());
  const failed = detail({
    observedAt: '2026-10-21T10:00:02.000Z',
    describeStatus: 'FAILED',
    stateStatus: 'failed',
  });
  assert.equal(
    byId(recoveryChecks(baseline, emptyRecoveryEvidence(), failed, true, true), 'completion').status,
    'fail',
  );

  const running = detail({ observedAt: '2026-10-21T10:00:02.000Z' });
  const checks = recoveryChecks(baseline, emptyRecoveryEvidence(), running, true, true);
  assert.equal(byId(checks, 'interruption').status, 'pending');
  assert.equal(byId(checks, 'history').status, 'pending');
  assert.equal(byId(checks, 'signal').status, 'pending');
  assert.equal(byId(checks, 'completion').status, 'pending');

  const unknown = detail({
    observedAt: '2026-10-21T10:00:03.000Z',
    describeStatus: 'UNSPECIFIED',
  });
  assert.equal(
    byId(recoveryChecks(baseline, emptyRecoveryEvidence(), unknown, true, true), 'completion').status,
    'pending',
  );
});
