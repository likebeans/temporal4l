import proto from '@temporalio/proto';
import type { temporal } from '@temporalio/proto';
import type { HistoryEvent } from '../shared/types';

type RawEvent = temporal.api.history.v1.IHistoryEvent;
const EventType = proto.temporal.api.enums.v1.EventType;

const EVENT_LABELS: Record<string, string> = {
  WorkflowExecutionStarted: '工作流已启动',
  WorkflowExecutionCompleted: '工作流已完成',
  WorkflowExecutionFailed: '工作流执行失败',
  WorkflowExecutionCanceled: '工作流已取消',
  WorkflowExecutionCancelRequested: '收到取消请求',
  WorkflowExecutionSignaled: '收到外部 Signal',
  WorkflowExecutionUpdateAdmitted: 'Update 已接纳',
  WorkflowExecutionUpdateAccepted: 'Update 已接受',
  WorkflowExecutionUpdateCompleted: 'Update 已完成',
  WorkflowExecutionTimedOut: '工作流执行超时',
  WorkflowExecutionTerminated: '工作流已终止',
  WorkflowTaskScheduled: '工作流任务已入队',
  WorkflowTaskStarted: 'Worker 开始工作流任务',
  WorkflowTaskCompleted: '工作流任务已完成',
  WorkflowTaskFailed: '工作流任务失败',
  WorkflowTaskTimedOut: '工作流任务超时',
  ActivityTaskScheduled: 'Activity 已安排',
  ActivityTaskStarted: 'Activity 开始执行',
  ActivityTaskCompleted: 'Activity 已完成',
  ActivityTaskFailed: 'Activity 重试耗尽',
  ActivityTaskTimedOut: 'Activity 执行超时',
  ActivityTaskCancelRequested: '请求取消 Activity',
  ActivityTaskCanceled: 'Activity 已取消',
  TimerStarted: '持久化定时器已创建',
  TimerFired: '持久化定时器已触发',
  TimerCanceled: '持久化定时器已取消',
};

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return 0;
}

function eventTime(event: RawEvent): string {
  const timestamp = event.eventTime;
  if (!timestamp) return '';
  return new Date(numeric(timestamp.seconds) * 1_000 + (timestamp.nanos ?? 0) / 1_000_000).toISOString();
}

function eventName(type: number | null | undefined): string {
  const raw = EventType[type ?? 0] ?? 'EVENT_TYPE_UNSPECIFIED';
  return raw.replace(/^EVENT_TYPE_/, '').toLowerCase()
    .split('_').map((word) => word[0]?.toUpperCase() + word.slice(1)).join('');
}

// 直接转换 Temporal History；不在 API 内存里另存一套订单进度。
export function presentHistory(events: RawEvent[]): HistoryEvent[] {
  const activityNames = new Map<string, string>();
  const acceptedUpdates = new Map<string, { updateId?: string; updateName?: string }>();
  for (const event of events) {
    const scheduled = event.activityTaskScheduledEventAttributes;
    if (scheduled) activityNames.set(String(event.eventId), scheduled.activityType?.name ?? 'Activity');

    const accepted = event.workflowExecutionUpdateAcceptedEventAttributes;
    if (accepted) {
      acceptedUpdates.set(String(event.eventId), {
        updateId: accepted.acceptedRequest?.meta?.updateId ?? accepted.protocolInstanceId ?? undefined,
        updateName: accepted.acceptedRequest?.input?.name ?? undefined,
      });
    }
  }

  return events.map((event) => {
    const type = eventName(event.eventType);
    const scheduled = event.activityTaskScheduledEventAttributes;
    const started = event.activityTaskStartedEventAttributes;
    const completed = event.activityTaskCompletedEventAttributes;
    const failed = event.activityTaskFailedEventAttributes;
    const timedOut = event.activityTaskTimedOutEventAttributes;
    const cancelled = event.activityTaskCanceledEventAttributes;
    const activityId = started?.scheduledEventId ?? completed?.scheduledEventId
      ?? failed?.scheduledEventId ?? timedOut?.scheduledEventId ?? cancelled?.scheduledEventId;
    const activity = scheduled?.activityType?.name ?? activityNames.get(String(activityId));
    const detail: string[] = [];
    if (activity) detail.push(activity);
    if (started?.attempt) detail.push(`第 ${started.attempt} 次尝试`);
    if (started?.lastFailure?.message) detail.push(`上次失败：${started.lastFailure.message}`);
    if (failed?.failure?.message) detail.push(failed.failure.message);
    if (event.workflowExecutionSignaledEventAttributes?.signalName) {
      detail.push(event.workflowExecutionSignaledEventAttributes.signalName);
    }
    if (event.workflowExecutionFailedEventAttributes?.failure?.message) {
      detail.push(event.workflowExecutionFailedEventAttributes.failure.message);
    }
    const admittedUpdate = event.workflowExecutionUpdateAdmittedEventAttributes?.request;
    const acceptedUpdate = event.workflowExecutionUpdateAcceptedEventAttributes;
    const completedUpdate = event.workflowExecutionUpdateCompletedEventAttributes;
    const completedAccepted = completedUpdate
      ? acceptedUpdates.get(String(completedUpdate.acceptedEventId))
      : undefined;
    const updateId = admittedUpdate?.meta?.updateId
      ?? acceptedUpdate?.acceptedRequest?.meta?.updateId
      ?? acceptedUpdate?.protocolInstanceId
      ?? completedUpdate?.meta?.updateId
      ?? completedAccepted?.updateId;
    const updateName = admittedUpdate?.input?.name
      ?? acceptedUpdate?.acceptedRequest?.input?.name
      ?? completedAccepted?.updateName;
    if (updateName) detail.push(updateName);
    if (updateId) detail.push(updateId);
    if (completedUpdate?.outcome?.failure?.message) {
      detail.push(`失败：${completedUpdate.outcome.failure.message}`);
    }
    if (event.timerStartedEventAttributes?.startToFireTimeout) {
      detail.push(`等待 ${numeric(event.timerStartedEventAttributes.startToFireTimeout.seconds)} 秒`);
    }
    const category: HistoryEvent['category'] = type.startsWith('WorkflowExecutionUpdate') ? 'update'
      : type.includes('Signaled') ? 'signal'
      : type.startsWith('Activity') ? 'activity'
      : type.startsWith('Timer') ? 'timer'
      : type.startsWith('Workflow') ? 'workflow' : 'other';
    const signalName = event.workflowExecutionSignaledEventAttributes?.signalName;
    return {
      id: String(event.eventId),
      type,
      timestamp: eventTime(event),
      label: EVENT_LABELS[type] ?? type,
      ...(detail.length ? { detail: detail.join(' · ') } : {}),
      ...(activity ? { activityType: activity } : {}),
      ...(started?.attempt ? { attempt: numeric(started.attempt) } : {}),
      ...(signalName ? { signalName } : {}),
      ...(updateId ? { updateId } : {}),
      ...(updateName ? { updateName } : {}),
      category,
    };
  });
}
