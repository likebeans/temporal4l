import type { ApprovalFeedback } from '../shared/approval';
import { APPROVE_SIGNAL, APPROVE_UPDATE, type HistoryEvent, type OrderDetail } from '../shared/types';
import type { LearningTopicId } from './learning-catalog';

export interface LearningObservation {
  id: string;
  source: 'History' | 'Query' | 'Describe' | 'SQLite' | 'HTTP 回执' | '恢复向导';
  status: 'observed' | 'unknown' | 'stale';
  value: string;
  note: string;
  events?: HistoryEvent[];
  result?: ApprovalFeedback['result'];
}

export interface LearningEvidenceInput {
  detail: OrderDetail | null;
  queryFresh: boolean;
  responseFresh: boolean;
  feedback?: ApprovalFeedback | null;
}

const activityNames: Partial<Record<LearningTopicId, string[]>> = {
  execution: ['reserveInventory', 'chargePayment', 'shipOrder'],
  recovery: ['reserveInventory', 'chargePayment', 'shipOrder', 'packOrder'],
  retry: ['reserveInventory', 'chargePayment', 'refundPayment', 'releaseInventory'],
  timer: ['refundPayment', 'releaseInventory'],
  idempotency: ['chargePayment'],
  cancellation: ['refundPayment', 'releaseInventory', 'packOrder'],
  heartbeat: ['packOrder'],
  signal: ['shipOrder'],
  update: ['shipOrder'],
};

function relevantEvents(topic: LearningTopicId, history: HistoryEvent[]): HistoryEvent[] {
  return history.filter((event) => {
    if (event.activityType && activityNames[topic]?.includes(event.activityType)) return true;
    if (event.type === 'WorkflowExecutionStarted' || ['WorkflowExecutionCompleted', 'WorkflowExecutionFailed', 'WorkflowExecutionCanceled'].includes(event.type)) return true;
    if (['execution', 'recovery', 'timer', 'signal'].includes(topic) && event.type.startsWith('Timer')) return true;
    if (['execution', 'recovery', 'signal'].includes(topic) && event.type === 'WorkflowExecutionSignaled' && event.signalName === APPROVE_SIGNAL) return true;
    if (topic === 'update' && event.type.startsWith('WorkflowExecutionUpdate') && event.updateName === APPROVE_UPDATE) return true;
    return topic === 'cancellation' && event.type === 'WorkflowExecutionCancelRequested';
  });
}

export function learningEvidence(topic: LearningTopicId, input: LearningEvidenceInput): LearningObservation[] {
  const { detail, responseFresh, queryFresh, feedback } = input;
  const rows: LearningObservation[] = [];
  const events = detail ? relevantEvents(topic, detail.history) : [];
  rows.push({
    id: 'history', source: 'History',
    status: !detail || events.length === 0 ? 'unknown' : responseFresh ? 'observed' : 'stale',
    value: events.length ? `当前 Run 中 ${events.length} 条相关事件` : '尚无相关事件',
    note: '事件是执行事实。中间 Activity 重试可能合并；单次历史不能证明 Worker 曾经停机。',
    events,
  });

  rows.push({
    id: 'execution', source: 'Describe',
    status: !detail ? 'unknown' : responseFresh ? 'observed' : 'stale',
    value: detail ? `执行状态 ${detail.status}` : '尚未读取执行状态',
    note: '这是本次 Describe 的状态；随后读取的 Query 和 History 不构成原子快照。',
  });

  const freshState = Boolean(detail?.state && queryFresh && responseFresh && !detail.stateError);
  const state = detail?.state;
  let stateValue = state ? `业务状态 ${state.status}` : 'Query 尚未返回业务状态';
  if (state && ['signal', 'update'].includes(topic)) {
    stateValue += state.approvedAt ? `；确认方式 ${state.approvalMethod ?? '未记录'}，approvedAt ${state.approvedAt}` : '；尚无 approvedAt';
    if (topic === 'update' && state.approvalUpdateId) stateValue += `；Update ID ${state.approvalUpdateId}`;
  }
  if (state && topic === 'timer') stateValue += state.approvalDeadline ? `；确认截止 ${state.approvalDeadline}` : '；尚无确认期限';
  if (state && topic === 'cancellation') {
    stateValue += `；补偿 ${state.compensationProgress?.status ?? '未记录'}`;
    for (const step of state.compensationProgress?.steps ?? []) stateValue += `；${step.label} ${step.status}`;
  }
  rows.push({
    id: 'business', source: 'Query',
    status: !state ? 'unknown' : freshState ? 'observed' : 'stale',
    value: stateValue,
    note: freshState ? '只读业务快照；业务状态提前变化不能替代执行终态或外部副作用证据。' : '缺少新鲜 Query；保留值仅供回看，不能据此断定当前业务进度。',
  });

  if (['retry', 'timer', 'idempotency', 'cancellation', 'recovery'].includes(topic)) {
    const payment = detail?.payment;
    rows.push({
      id: 'payment', source: 'SQLite',
      status: !payment ? 'unknown' : responseFresh ? 'observed' : 'stale',
      value: payment ? `付款调用 ${payment.attempts} 次；扣款 ${payment.debitCount} 次 / ¥${payment.totalCharged}；退款 ${payment.refundCount} 次 / ¥${payment.totalRefunded}` : '尚未读取支付账本',
      note: '账本按 Workflow ID 归集，独立于 Run History。零流水不能证明旧订单未曾付款；退款 Activity 成功也可能只做了查账。',
    });
    if (payment) {
      rows.push({
        id: 'ledger-entries', source: 'SQLite',
        status: payment.entries.length === 0 ? 'unknown' : responseFresh ? 'observed' : 'stale',
        value: payment.entries.length ? payment.entries.map((entry) => `流水 #${entry.id} ${entry.kind} · attempt ${entry.attempt} · ¥${entry.amount}`).join('\n') : '尚无付款流水',
        note: `稳定幂等键 ${payment.idempotencyKey}；流水 ID 是账本 ID，与 History 事件 ID 不同。`,
      });
    }
  }

  if (topic === 'retry' || topic === 'heartbeat') {
    const pending = detail?.pendingActivities.filter((activity) => activity.activityType === (topic === 'retry' ? 'chargePayment' : 'packOrder')) ?? [];
    rows.push({
      id: 'pending', source: 'Describe',
      status: !pending.length ? 'unknown' : responseFresh ? 'observed' : 'stale',
      value: pending.length ? pending.map((activity) => `${activity.activityType} · ${activity.state} · attempt ${activity.attempt}${activity.lastFailure ? ` · 上次失败 ${activity.lastFailure}` : ''}`).join('\n') : '当前没有对应的 Pending Activity',
      note: '活动结束后会离开 Pending Activities；可回看 History 中记录的最终 attempt，不能把空列表理解为从未执行。',
    });
  }

  if (topic === 'heartbeat') {
    const activity = detail?.pendingActivities.find((item) => item.activityType === 'packOrder');
    const heartbeat = activity?.heartbeat;
    const matched = Boolean(heartbeat && heartbeat.attempt === activity?.attempt && ['STARTED', 'CANCEL_REQUESTED'].includes(activity!.state));
    const completed = !activity && freshState ? state?.packing : undefined;
    const checkpoint = matched ? heartbeat : completed;
    rows.push({
      id: 'checkpoint', source: activity ? 'Describe' : 'Query',
      status: !checkpoint ? 'unknown' : responseFresh && (activity || freshState) ? 'observed' : 'stale',
      value: checkpoint ? `attempt ${checkpoint.attempt}；已保存 ${checkpoint.completedBatches}/${checkpoint.totalBatches} 批；resumedFrom ${checkpoint.resumedFrom}；${checkpoint.phase}` : heartbeat ? `待观察：Pending attempt ${activity!.attempt}，心跳 attempt ${heartbeat.attempt}，状态 ${activity!.state}` : '尚无可用检查点',
      note: checkpoint ? 'Describe 展示服务端最近收到的心跳；Query 的 packing 是 Activity 成功返回的最终结果。resumedFrom 说明 Activity 新尝试，不单独证明进程崩溃恢复。' : '尚未收到匹配当前尝试的可靠检查点；不使用旧 attempt 心跳或旧 Query 推断恢复。',
    });
  }

  if (topic === 'signal' || topic === 'update') {
    const receipt = feedback && detail && feedback.workflowId === detail.workflowId && feedback.runId === detail.runId && feedback.method === topic ? feedback : undefined;
    const updateId = receipt?.request?.updateId;
    rows.push({
      id: 'receipt', source: 'HTTP 回执', status: receipt ? 'observed' : 'unknown',
      value: receipt ? `${receipt.status}${updateId ? ` · Update ID ${updateId}` : ''}\n${receipt.message}` : '本页没有保存这次 Run 对应的请求回执',
      result: receipt?.result,
      note: '回执是该次请求的记录，不是当前业务状态。刷新后可能丢失；validator 拒绝看真实回执，Completed 也可能携带失败 outcome。',
    });
    if (topic === 'update' && updateId) {
      const related = events.filter((event) => event.updateId === updateId);
      rows.push({
        id: 'update-events', source: 'History',
        status: !related.length ? 'unknown' : responseFresh ? 'observed' : 'stale',
        value: related.length ? `原 Update ID 对应 ${related.length} 条事件` : '原 Update ID 暂无对应历史事件',
        note: '只关联当前 Run 的同一 Update ID；成功返回值、历史 outcome 与整个 Workflow 完成分别核对。',
        events: related,
      });
    }
  }

  if (topic === 'recovery') rows.push({
    id: 'recovery-baseline', source: '恢复向导', status: 'unknown',
    value: '本视图不判定跨阶段恢复结果',
    note: '请在 Worker 恢复实验中核对固定 Run、实验基线、Query 中断边界、停机 Signal、后续 Workflow Task 和账本变化。',
  });
  return rows;
}
