import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ApprovalFeedback } from '../shared/approval';
import type { HistoryEvent, OrderDetail, PackingCheckpoint } from '../shared/types';
import { LEARNING_TOPICS, type LearningSourcePath } from '../src/learning-catalog';
import { learningEvidence } from '../src/learning-evidence';
import { collectSourceExcerpts, extractSource } from '../src/source-excerpts';

const workflowId = 'learning-order-source-evidence';
const runId = 'source-evidence-run';
const observedAt = '2026-10-27T10:00:00.000Z';

function event(id: string, type: string, fields: Partial<HistoryEvent> = {}): HistoryEvent {
  return { id, type, timestamp: observedAt, label: type, category: 'workflow', ...fields };
}

function detail(): OrderDetail {
  return {
    workflowId, runId, status: 'RUNNING', observedAt,
    state: {
      workflowId, input: { customerName: '证据测试', productId: 'keyboard', quantity: 1, scenario: 'idempotency', approvalTimeoutSeconds: 120 },
      status: 'waiting_approval', steps: [], total: 299, createdAt: observedAt, updatedAt: observedAt,
    },
    history: [
      event('1', 'WorkflowExecutionStarted'),
      event('5', 'ActivityTaskScheduled', { activityType: 'chargePayment' }),
      event('6', 'ActivityTaskStarted', { activityType: 'chargePayment', attempt: 2 }),
      event('7', 'ActivityTaskCompleted', { activityType: 'chargePayment' }),
    ],
    pendingActivities: [],
    payment: {
      idempotencyKey: `${workflowId}:charge`, attempts: 2, debitCount: 1, refundCount: 0, totalCharged: 299, totalRefunded: 0,
      entries: [
        { id: 1, kind: 'attempt', attempt: 1, amount: 0, message: '首次尝试', createdAt: observedAt },
        { id: 2, kind: 'debit', attempt: 1, amount: 299, message: '入账', createdAt: observedAt },
        { id: 3, kind: 'attempt', attempt: 2, amount: 0, message: '重试', createdAt: observedAt },
        { id: 4, kind: 'reused', attempt: 2, amount: 0, message: '幂等命中', createdAt: observedAt },
      ],
    },
  };
}

function checkpoint(attempt: number): PackingCheckpoint {
  return { completedBatches: 5, totalBatches: 12, attempt, resumedFrom: 3, phase: 'packing', updatedAt: observedAt };
}

test('无运行时所有主题仅显示待观察，不构造执行证据', () => {
  for (const topic of LEARNING_TOPICS) {
    const rows = learningEvidence(topic.id, { detail: null, queryFresh: false, responseFresh: false });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.status === 'unknown'));
    assert.ok(rows.every((row) => !row.events?.length));
  }
});

test('支付调用和扣款来自账本，不使用 History 事件数量推断', () => {
  const current = detail();
  const rows = learningEvidence('idempotency', { detail: current, queryFresh: true, responseFresh: true });
  const payment = rows.find((row) => row.id === 'payment')!;
  assert.equal(payment.status, 'observed');
  assert.match(payment.value, /付款调用 2 次；扣款 1 次/);
  assert.match(rows.find((row) => row.id === 'ledger-entries')!.value, /流水 #4 reused · attempt 2/);
  assert.equal(rows.find((row) => row.id === 'history')!.events!.length, 4);
  assert.deepEqual(current, detail(), '证据读取不能修改订单快照');
});

test('Query 单独失败时旧业务快照过期，其他来源仍可读取；整体响应失败使它们全部过期', () => {
  const current = { ...detail(), stateError: 'Query 不可用' };
  const queryFailed = learningEvidence('idempotency', { detail: current, queryFresh: true, responseFresh: true });
  assert.equal(queryFailed.find((row) => row.id === 'business')!.status, 'stale');
  for (const id of ['history', 'execution', 'payment', 'ledger-entries']) {
    assert.equal(queryFailed.find((row) => row.id === id)!.status, 'observed');
  }
  const allFailed = learningEvidence('idempotency', { detail: detail(), queryFresh: true, responseFresh: false });
  assert.ok(allFailed.every((row) => row.status === 'stale'));
});

test('新 Pending attempt 带旧心跳，或尚未开始时，不认证检查点', () => {
  for (const [attempt, state] of [[2, 'STARTED'], [1, 'SCHEDULED']] as const) {
    const current = detail();
    current.pendingActivities = [{ activityId: 'packing', activityType: 'packOrder', attempt, state, heartbeat: checkpoint(1) }];
    current.state!.packing = { ...checkpoint(3), phase: 'completed' };
    const row = learningEvidence('heartbeat', { detail: current, queryFresh: true, responseFresh: true }).find((item) => item.id === 'checkpoint')!;
    assert.equal(row.status, 'unknown');
    assert.match(row.value, /待观察/);
    assert.doesNotMatch(row.value, /resumedFrom/);
  }
});

test('匹配心跳与完成后的新鲜 Query 可以展示检查点，旧 Query 不能补齐检查点', () => {
  const current = detail();
  current.pendingActivities = [{ activityId: 'packing', activityType: 'packOrder', attempt: 2, state: 'STARTED', heartbeat: checkpoint(2) }];
  const row = () => learningEvidence('heartbeat', { detail: current, queryFresh: true, responseFresh: true }).find((item) => item.id === 'checkpoint')!;
  assert.equal(row().status, 'observed');
  assert.equal(row().source, 'Describe');
  assert.match(row().value, /resumedFrom 3/);
  current.pendingActivities = [];
  current.state!.packing = { ...checkpoint(2), phase: 'completed', completedBatches: 12 };
  assert.equal(row().status, 'observed');
  assert.equal(row().source, 'Query');
  const stale = learningEvidence('heartbeat', { detail: current, queryFresh: false, responseFresh: true }).find((item) => item.id === 'checkpoint')!;
  assert.equal(stale.status, 'unknown');
  assert.doesNotMatch(stale.value, /resumedFrom/);
});

test('恢复主题只展示当前记录，不由单次完成快照证明停机恢复', () => {
  const current = detail();
  current.status = 'COMPLETED';
  current.state!.status = 'completed';
  current.history.push(event('20', 'WorkflowExecutionCompleted'));
  const rows = learningEvidence('recovery', { detail: current, queryFresh: true, responseFresh: true });
  assert.equal(rows.find((row) => row.id === 'recovery-baseline')!.status, 'unknown');
  assert.match(rows.find((row) => row.id === 'recovery-baseline')!.value, /不判定/);
});

test('Update 失败 Completed 与真实拒绝回执分别呈现，按原 ID 关联事件', () => {
  const current = detail();
  current.history.push(
    event('10', 'WorkflowExecutionUpdateAccepted', { updateName: 'approveOrderUpdate', updateId: 'update-a' }),
    event('11', 'WorkflowExecutionUpdateCompleted', { updateName: 'approveOrderUpdate', updateId: 'update-a', detail: '失败：确认未完成' }),
    event('12', 'WorkflowExecutionUpdateCompleted', { updateName: 'approveOrderUpdate', updateId: 'update-b' }),
  );
  const feedback: ApprovalFeedback = {
    workflowId, runId, method: 'update', status: 'rejected', message: '真实 handler 拒绝',
    request: { runId, updateId: 'update-a', confirmed: true },
  };
  const rows = learningEvidence('update', { detail: current, queryFresh: true, responseFresh: true, feedback });
  assert.match(rows.find((row) => row.id === 'receipt')!.value, /rejected.*update-a/s);
  assert.match(rows.find((row) => row.id === 'receipt')!.value, /真实 handler 拒绝/);
  assert.deepEqual(rows.find((row) => row.id === 'update-events')!.events!.map((item) => item.id), ['10', '11']);
  assert.match(rows.find((row) => row.id === 'update-events')!.events![1].detail!, /失败/);
  assert.ok(rows.every((row) => !('passed' in row)), '只呈现证据，不自动评定实验成功');
  const wrongRun = learningEvidence('update', { detail: current, queryFresh: true, responseFresh: true, feedback: { ...feedback, runId: 'other-run' } });
  assert.equal(wrongRun.find((row) => row.id === 'receipt')!.status, 'unknown');
  assert.equal(wrongRun.find((row) => row.id === 'update-events'), undefined);
});

test('当前源码的所有教学定位有效，摘录正文与行号一致，失效定位明确报错', () => {
  const paths = [...new Set(LEARNING_TOPICS.flatMap((topic) => topic.sources.map((source) => source.file)))];
  const sources = Object.fromEntries(paths.map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')])) as Record<LearningSourcePath, string>;
  const excerpts = collectSourceExcerpts(sources);
  for (const topic of LEARNING_TOPICS) {
    assert.equal(excerpts[topic.id].length, topic.sources.length);
    for (const excerpt of excerpts[topic.id]) {
      assert.equal(excerpt.code, sources[excerpt.file].split('\n').slice(excerpt.startLine - 1, excerpt.endLine).join('\n'));
      assert.ok(excerpt.endLine >= excerpt.startLine);
      assert.ok(excerpt.code.length > 20);
    }
  }
  assert.match(excerpts.execution[0].code, /client\.workflow\.start/);
  assert.match(excerpts.execution[2].code, /await condition/);
  assert.match(excerpts.cancellation[0].code, /nonCancellable/);
  assert.throws(() => extractSource('changed file', LEARNING_TOPICS[0].sources[0]), /教学源码定位失效/);
});
