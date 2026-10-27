import assert from 'node:assert/strict';
import test from 'node:test';
import proto from '@temporalio/proto';
import { presentHistory } from '../server/history';

const EventType = proto.temporal.api.enums.v1.EventType;

test('真实历史转换能关联 Activity，展示重试次数和上次失败', () => {
  const events = presentHistory(proto.temporal.api.history.v1.History.fromObject({ events: [
    {
      eventId: 5,
      eventType: EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
      eventTime: { seconds: 1_700_000_000, nanos: 500_000_000 },
      activityTaskScheduledEventAttributes: { activityType: { name: 'chargePayment' } },
    },
    {
      eventId: 6,
      eventType: EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED,
      activityTaskStartedEventAttributes: { scheduledEventId: 5, attempt: 3, lastFailure: { message: '模拟支付网关不可用' } },
    },
    {
      eventId: 7,
      eventType: EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED,
      activityTaskCompletedEventAttributes: { scheduledEventId: 5 },
    },
    {
      eventId: 8,
      eventType: EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED,
      workflowExecutionSignaledEventAttributes: { signalName: 'approveOrder' },
    },
  ] }).events);
  assert.equal(events[0].type, 'ActivityTaskScheduled');
  assert.equal(events[0].timestamp, '2023-11-14T22:13:20.500Z');
  assert.equal(events[0].activityType, 'chargePayment');
  assert.equal(events[1].detail, 'chargePayment · 第 3 次尝试 · 上次失败：模拟支付网关不可用');
  assert.equal(events[1].activityType, 'chargePayment');
  assert.equal(events[1].attempt, 3);
  assert.equal(events[2].detail, 'chargePayment');
  assert.equal(events[2].activityType, 'chargePayment');
  assert.equal(events[3].category, 'signal');
  assert.equal(events[3].detail, 'approveOrder');
  assert.equal(events[3].signalName, 'approveOrder');
});

test('失败与 Timer 事件提供可读原因和定时器长度', () => {
  const events = presentHistory(proto.temporal.api.history.v1.History.fromObject({ events: [
    {
      eventId: 1,
      eventType: EventType.EVENT_TYPE_TIMER_STARTED,
      timerStartedEventAttributes: { startToFireTimeout: { seconds: 15 } },
    },
    {
      eventId: 2,
      eventType: EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
      workflowExecutionFailedEventAttributes: { failure: { message: '人工确认超时' } },
    },
  ] }).events);
  assert.equal(events[0].category, 'timer');
  assert.equal(events[0].detail, '等待 15 秒');
  assert.equal(events[1].label, '工作流执行失败');
  assert.equal(events[1].detail, '人工确认超时');
});

test('Update 历史展示接纳、接受、完成及失败结果', () => {
  const events = presentHistory(proto.temporal.api.history.v1.History.fromObject({ events: [
    {
      eventId: 9,
      eventType: EventType.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ADMITTED,
      workflowExecutionUpdateAdmittedEventAttributes: {
        request: {
          meta: { updateId: 'approval-update-1' },
          input: { name: 'approveOrderUpdate' },
        },
      },
    },
    {
      eventId: 10,
      eventType: EventType.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED,
      workflowExecutionUpdateAcceptedEventAttributes: {
        protocolInstanceId: 'approval-update-1',
        acceptedRequest: {
          meta: { updateId: 'approval-update-1' },
          input: { name: 'approveOrderUpdate' },
        },
      },
    },
    {
      eventId: 11,
      eventType: EventType.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_COMPLETED,
      workflowExecutionUpdateCompletedEventAttributes: {
        meta: { updateId: 'approval-update-1' },
        acceptedEventId: 10,
        outcome: { failure: { message: '人工确认处理失败' } },
      },
    },
  ] }).events);

  assert.deepEqual(
    events.map(({ type, label, category, updateId, updateName }) => ({
      type, label, category, updateId, updateName,
    })),
    [
      {
        type: 'WorkflowExecutionUpdateAdmitted',
        label: 'Update 已接纳',
        category: 'update',
        updateId: 'approval-update-1',
        updateName: 'approveOrderUpdate',
      },
      {
        type: 'WorkflowExecutionUpdateAccepted',
        label: 'Update 已接受',
        category: 'update',
        updateId: 'approval-update-1',
        updateName: 'approveOrderUpdate',
      },
      {
        type: 'WorkflowExecutionUpdateCompleted',
        label: 'Update 已完成',
        category: 'update',
        updateId: 'approval-update-1',
        updateName: 'approveOrderUpdate',
      },
    ],
  );
  assert.equal(events[2].detail, 'approveOrderUpdate · approval-update-1 · 失败：人工确认处理失败');
});
