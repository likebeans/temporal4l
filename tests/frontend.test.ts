import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { ApiError, api } from '../src/api';
import { isTerminalExecutionStatus, orderStatusLabel, orderStatusTone } from '../src/format';
import type { OrderDetail } from '../shared/types';
import type { ApprovalFeedback } from '../shared/approval';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function browser(t: test.TestContext) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  dom.window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id: number | undefined) => { if (id !== undefined) timers.delete(id); };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return {
    dom,
    root,
    async tick(delay: number) {
      const timer = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(timer, `没有等待 ${delay}ms 的轮询`);
      timers.delete(timer[0]);
      await act(async () => timer[1].callback());
    },
    async click(element: Element | null) {
      assert.ok(element, '交互目标必须存在');
      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => element.dispatchEvent(event));
      return event;
    },
    button(text: string) {
      return [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
    },
  };
}

const workflowId = 'learning-order-28147653-e167-41d6-a9f6-3719db5c89bf';
const runId = '2d35abe6-42d0-4bf4-9aa8-fdb4b0629a6b';
const observedAt = '2026-10-27T10:00:00.000Z';

function waitingDetail(): OrderDetail {
  return {
    workflowId, runId, status: 'RUNNING', observedAt,
    state: {
      workflowId,
      input: { customerName: '前端回归测试', productId: 'keyboard', quantity: 1, scenario: 'normal', approvalTimeoutSeconds: 300 },
      status: 'waiting_approval', total: 299, createdAt: observedAt, updatedAt: observedAt,
      steps: [
        { id: 'inventory', label: '预留库存', kind: 'Activity', status: 'completed', detail: '库存已预留' },
        { id: 'payment', label: '收取货款', kind: 'Activity', status: 'completed', detail: '付款成功' },
        { id: 'approval', label: '人工确认', kind: 'Signal / Update', status: 'waiting', detail: '等待确认' },
        { id: 'shipping', label: '创建发货单', kind: 'Activity', status: 'pending', detail: '等待执行' },
      ],
    },
    history: [], pendingActivities: [],
    payment: { idempotencyKey: `${workflowId}:charge`, attempts: 1, debitCount: 1, refundCount: 0, totalCharged: 299, totalRefunded: 0, entries: [] },
  };
}

async function assertStaleRefresh(t: test.TestContext, failure: 'http' | 'query') {
  const warning = failure === 'http' ? '暂时无法刷新' : 'Query 暂不可用';
  const page = await browser(t);
  const update = deferred<never>();
  const refreshed = deferred<OrderDetail>();
  let detailRequests = 0;
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [{ workflowId, runId, status: 'RUNNING', startedAt: observedAt }] }));
  t.mock.method(api, 'getOrder', () => {
    detailRequests += 1;
    if (detailRequests === 1) return Promise.resolve(waitingDetail());
    if (detailRequests === 2) {
      return failure === 'http'
        ? Promise.reject(new Error('详情暂时不可用'))
        : Promise.resolve({ ...waitingDetail(), state: null, stateError: 'Query 暂时不可用' });
    }
    return refreshed.promise;
  });
  t.mock.method(api, 'approveOrderUpdate', () => update.promise);
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  assert.ok(page.button('取消这条 Workflow'));

  await page.click(page.dom.window.document.querySelector('input[value="update"]'));
  await page.click(page.button('校验拒绝实验')!);
  await page.tick(1_500);
  assert.ok(page.dom.window.document.body.textContent!.includes(warning), '刷新失败必须显示对应的旧快照提示');
  assert.equal(page.button('前往确认'), undefined, '过期的等待确认快照不能显示当前操作提示');
  assert.equal(page.button('取消这条 Workflow'), undefined);

  await act(async () => update.reject(new ApiError('请先确认已核对订单信息', 409, { status: 'rejected' })));
  assert.equal(detailRequests, 3, 'Update 返回应立即重新读取详情');
  assert.ok(page.dom.window.document.body.textContent!.includes(warning), '刷新失败必须显示对应的旧快照提示');
  assert.equal(page.button('取消这条 Workflow'), undefined, '新详情未返回时不能重新开放取消');
  assert.equal(page.button('校验拒绝实验')?.disabled, true, '旧快照不能重新开放确认');

  await act(async () => refreshed.resolve({ ...waitingDetail(), observedAt: '2026-10-27T10:00:01.000Z' }));
  assert.equal(page.dom.window.document.body.textContent!.includes(warning), false);
  assert.equal(page.button('取消这条 Workflow')?.disabled, false);
  assert.equal(page.button('校验拒绝实验')?.disabled, false);
  assert.ok(page.button('前往确认'), '新鲜的等待确认响应应恢复当前操作提示');
}

for (const failure of ['http', 'query'] as const) {
  test(`${failure === 'http' ? '详情请求' : 'Query'}失败后重启刷新仍锁定旧快照，直到新响应成功`, (t) => (
    assertStaleRefresh(t, failure)
  ));
}

test('断连提示可选择原生或 Docker，复制当前命令且不启动订单', async (t) => {
  const page = await browser(t);
  let healthUnavailable = false;
  t.mock.method(api, 'getHealth', async () => {
    if (healthUnavailable) throw new TypeError('Failed to fetch');
    return { temporal: false, worker: false, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' };
  });
  t.mock.method(api, 'getOrders', async () => ({ orders: [] }));
  const create = t.mock.method(api, 'createOrder', async () => ({ workflowId, runId }));
  const copied: string[] = [];
  Object.defineProperty(page.dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  const document = page.dom.window.document;
  const commands = () => [...document.querySelectorAll('.command code')].map((code) => code.textContent);
  assert.equal(document.querySelector<HTMLInputElement>('input[name="temporal-startup-mode"][value="native"]')?.checked, true);
  assert.deepEqual(commands(), ['npm run temporal:local', 'npm run dev']);
  assert.ok(document.querySelector('.disconnected-state')?.textContent?.includes('只选择一种'));
  assert.ok(document.querySelector('.disconnected-state')?.textContent?.includes('已有服务时直接复用'));
  await page.click(document.querySelector('button[aria-label="复制命令 npm run temporal:local"]'));
  assert.deepEqual(copied, ['npm run temporal:local']);
  await page.click(document.querySelector('input[name="temporal-startup-mode"][value="docker"]'));
  assert.deepEqual(commands(), ['npm run temporal:up', 'npm run dev']);
  await page.click(document.querySelector('button[aria-label="复制命令 npm run temporal:up"]'));
  assert.deepEqual(copied, ['npm run temporal:local', 'npm run temporal:up']);
  await page.click(document.querySelector('input[name="temporal-startup-mode"][value="native"]'));
  assert.deepEqual(commands(), ['npm run temporal:local', 'npm run dev']);
  healthUnavailable = true;
  await page.tick(3_000);
  assert.equal(document.querySelector('.disconnected-state__copy > p:last-child')?.textContent, '无法连接本地 API，请确认开发服务已启动。');
  assert.equal(create.mock.calls.length, 0);
});

test('学习路线入口与顶部开关同步，展开学习内容不会创建订单', async (t) => {
  const page = await browser(t);
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [] }));
  const create = t.mock.method(api, 'createOrder', async () => ({ workflowId, runId }));
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));

  const document = page.dom.window.document;
  const body = document.getElementById('learning-guide-body')!;
  const toggles = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-controls="learning-guide-body"]')];
  assert.ok(document.getElementById('learning-guide'), '折叠后仍应显示学习入口');
  assert.equal(body.hidden, true);
  assert.equal(toggles().length, 2);
  assert.ok(toggles().every((toggle) => toggle.getAttribute('aria-expanded') === 'false'));

  await page.click(page.button('学习指南')!);
  assert.equal(document.getElementById('learning-guide')!.closest('.lab-workspace')?.hasAttribute('hidden'), false);
  assert.equal(body.hidden, false);
  assert.ok(toggles().every((toggle) => toggle.getAttribute('aria-expanded') === 'true'));
  const stages = [...document.querySelectorAll<HTMLDetailsElement>('.learning-path details')];
  assert.equal(stages.length, 5);
  assert.equal(stages[0].open, true);
  assert.equal(stages[4].open, false);
  await page.click(stages[4].querySelector('summary'));
  assert.equal(stages[4].open, true, '可独立展开后续阶段');

  await page.click(page.button('学习指南')!);
  assert.equal(body.hidden, true);
  assert.ok(toggles().every((toggle) => toggle.getAttribute('aria-expanded') === 'false'));
  await page.click(page.button('学习指南')!);
  assert.equal(body.hidden, false);
  assert.equal(stages[4].open, true, '折叠整个指南后仍保留已展开的阶段');
  const start = document.querySelector<HTMLAnchorElement>('.learning-guide__start')!;
  assert.ok(document.querySelector(start.getAttribute('href')!), '第一课入口必须指向真实表单位置');
  assert.equal(create.mock.calls.length, 0, '查看学习路线不能启动工作流');
});

test('自测先作答再展开参考，折叠保持草稿并导出手工记录，查看练习不启动订单', async (t) => {
  const page = await browser(t);
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [] }));
  const create = t.mock.method(api, 'createOrder', async () => ({ workflowId, runId }));
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  const document = page.dom.window.document;
  const start = document.querySelector<HTMLAnchorElement>('a[href="#learning-practice"]')!;
  assert.ok(document.querySelector(start.getAttribute('href')!));
  await page.click(start);
  const toggle = page.button('收起自测与练习')!;
  const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  assert.equal(body.hidden, false);
  assert.equal(document.getElementById('learning-practice')!.closest('.lab-workspace')?.hasAttribute('hidden'), false);
  assert.equal(document.querySelectorAll('.self-check-question').length, 10);
  const reference = document.querySelector<HTMLDetailsElement>('.self-check-reference')!;
  assert.equal(reference.open, false);
  const answer = document.querySelector<HTMLTextAreaElement>('[id$="-answer-roles"]')!;
  const explanation = 'API 启动执行，Server 保存历史。\n还需核对发货事件。';
  const setTextarea = Object.getOwnPropertyDescriptor(page.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  const setInput = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setTextarea.call(answer, explanation);
    answer.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
    const noteId = document.querySelector<HTMLInputElement>('[id$="-note-workflowId"]')!;
    setInput.call(noteId, workflowId);
    noteId.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  });
  await page.click(reference.querySelector('summary'));
  assert.equal(reference.open, true);
  await page.click(page.button('收起自测与练习')!);
  assert.equal(body.hidden, true);
  await page.click(page.button('展开自测与练习')!);
  assert.equal(answer.value, explanation);
  assert.equal(reference.open, true);
  const blobs: Blob[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { blobs.push(blob); return 'blob:learning-notes'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const click = t.mock.method(page.dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) {
    assert.equal(this.download, 'temporal-learning-notes.md');
    assert.equal(this.href, 'blob:learning-notes');
  });
  await page.click(page.button('导出作答与实验记录')!);
  assert.equal(click.mock.calls.length, 1);
  const exported = await blobs[0].text();
  assert.ok(exported.includes(explanation));
  assert.ok(exported.includes(workflowId));
  assert.match(exported, /尚未填写/);
  assert.doesNotMatch(exported, /已记录成功的 Activity 复用历史结果/, '导出仅含题目、作答与记录，不夹带参考答案');
  assert.match(document.querySelector('.practice-export [role="status"]')!.textContent!, /已生成/);
  assert.equal(create.mock.calls.length, 0);
});

test('自测草稿重挂载可恢复，损坏或禁用存储不阻止编辑与导出', async (t) => {
  const page = await browser(t);
  const { LearningPractice } = await import('../src/components/LearningPractice');
  page.dom.window.localStorage.setItem('temporal4l.answers.v1', JSON.stringify({ roles: '保留下来的预测' }));
  page.dom.window.localStorage.setItem('temporal4l.experiment-note.v1', 'broken-json');
  await act(async () => page.root.render(createElement(LearningPractice, { expanded: true })));
  let answer = page.dom.window.document.querySelector<HTMLTextAreaElement>('[id$="-answer-roles"]')!;
  assert.equal(answer.value, '保留下来的预测');
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(answer, '更新后的解释');
    answer.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => page.root.render(null));
  await act(async () => page.root.render(createElement(LearningPractice, { expanded: true })));
  answer = page.dom.window.document.querySelector<HTMLTextAreaElement>('[id$="-answer-roles"]')!;
  assert.equal(answer.value, '更新后的解释');
  await act(async () => page.root.render(null));
  t.mock.method(page.dom.window.Storage.prototype, 'getItem', () => { throw new Error('blocked'); });
  t.mock.method(page.dom.window.Storage.prototype, 'setItem', () => { throw new Error('blocked'); });
  await act(async () => page.root.render(createElement(LearningPractice, { expanded: true })));
  assert.match(page.dom.window.document.body.textContent!, /浏览器存储不可用/);
  assert.ok(page.button('导出作答与实验记录'));
});

test('浏览器无法导出时明确保留草稿供复制，不显示保存成功', async (t) => {
  const page = await browser(t);
  const { LearningPractice } = await import('../src/components/LearningPractice');
  await act(async () => page.root.render(createElement(LearningPractice)));
  await page.click(page.button('展开自测与练习')!);
  const document = page.dom.window.document;
  const answer = document.querySelector<HTMLTextAreaElement>('[id$="-answer-roles"]')!;
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(answer, '导出失败也应保留的预测');
    answer.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  });
  t.mock.method(URL, 'createObjectURL', () => { throw new Error('下载不可用'); });
  await page.click(page.button('导出作答与实验记录')!);
  assert.match(document.querySelector('.practice-export [role="status"]')!.textContent!, /未能导出.*复制/);
  assert.equal(answer.value, '导出失败也应保留的预测');
});

test('核心代码可通过键盘访问，并按需展开进阶摘录', async (t) => {
  const page = await browser(t);
  const { InspectorTabs } = await import('../src/components/InspectorTabs');
  await act(async () => page.root.render(createElement(InspectorTabs, { detail: null })));
  const document = page.dom.window.document;
  const tabList = document.querySelector('[role="tablist"]')!;
  await act(async () => {
    tabList.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  });
  const tab = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
  assert.equal(tab.textContent, '核心代码概念');
  assert.equal(document.activeElement, tab);
  const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
  assert.equal(panel.hidden, false);
  assert.ok(panel.querySelector('pre[aria-label="Workflow 编排主干"]'));
  const advanced = panel.querySelector<HTMLDetailsElement>('.code-concept__advanced')!;
  assert.equal(advanced.open, false);
  await page.click(advanced.querySelector('summary'));
  assert.equal(advanced.open, true);
  assert.ok(advanced.querySelector('pre[aria-label="消息与恢复进阶摘录"]'));
});

test('源码证据引用跳到当前 Run 的 History，返回后保留观察主题', async (t) => {
  const page = await browser(t);
  const { InspectorTabs } = await import('../src/components/InspectorTabs');
  const current = waitingDetail();
  current.history = [{ id: '18', type: 'WorkflowExecutionSignaled', signalName: 'approveOrder', category: 'signal', timestamp: observedAt, label: '收到外部 Signal' }];
  const render = async (detail: OrderDetail) => act(async () => page.root.render(createElement(InspectorTabs, {
    detail, queryFresh: true, responseFresh: true,
  })));
  await render(current);
  const document = page.dom.window.document;
  await page.click(page.button('源码与证据')!);
  const select = document.querySelector<HTMLSelectElement>('.source-topic select')!;
  await act(async () => {
    select.value = 'signal';
    select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  });
  const reference = document.querySelector<HTMLButtonElement>('button[aria-label="查看事件 #18 WorkflowExecutionSignaled"]')!;
  await page.click(reference);
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent, '事件历史1');
  const target = document.querySelector<HTMLElement>('.event-list .is-referenced')!;
  assert.equal(document.activeElement, target);
  assert.match(target.textContent!, /#18 · WorkflowExecutionSignaled/);
  await page.click(page.button('源码与证据')!);
  assert.equal(select.value, 'signal', '跳转回看后保留主题');
  await render({ ...current, runId: 'different-run', history: [] });
  assert.equal((document.querySelector('.source-topic select') as HTMLSelectElement).value, 'execution', '切换 Run 后重新选择观察上下文');
  await page.click(page.button('事件历史')!);
  assert.equal(document.querySelector('.event-list .is-referenced'), null, '旧 Run 的事件引用不能指向新 Run');
});

test('Update 证据直接呈现失败 outcome 与真实 handler 返回值，其他 Run 的回执不混入', async (t) => {
  const page = await browser(t);
  const { InspectorTabs } = await import('../src/components/InspectorTabs');
  const current = waitingDetail();
  current.history = [
    { id: '10', type: 'WorkflowExecutionUpdateAccepted', updateName: 'approveOrderUpdate', updateId: 'update-a', category: 'update', timestamp: observedAt, label: 'Update 已接受' },
    { id: '11', type: 'WorkflowExecutionUpdateCompleted', updateName: 'approveOrderUpdate', updateId: 'update-a', category: 'update', timestamp: observedAt, label: 'Update 已完成', detail: '失败：确认未完成' },
  ];
  const rejected: ApprovalFeedback = {
    workflowId, runId, method: 'update', status: 'rejected', message: '真实 handler 拒绝',
    request: { runId, updateId: 'update-a', confirmed: true },
  };
  const render = async (feedback: ApprovalFeedback) => act(async () => page.root.render(createElement(InspectorTabs, {
    detail: current, queryFresh: true, responseFresh: true, feedback,
  })));
  await render(rejected);
  await page.click(page.button('源码与证据')!);
  const document = page.dom.window.document;
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>('.source-topic select')!;
    select.value = 'update';
    select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  });
  const receipt = () => document.querySelector('[data-observation="receipt"]')!;
  assert.match(receipt().textContent!, /rejected.*update-a.*真实 handler 拒绝/s);
  assert.match(document.querySelector('[data-observation="update-events"] .observation-events')!.textContent!, /失败：确认未完成/);
  assert.equal(receipt().querySelector('pre'), null, '拒绝回执不能生成成功结果');
  const result = { workflowId, runId, updateId: 'update-b', approvedAt: observedAt, status: 'approved' as const };
  await render({ ...rejected, status: 'approved', message: 'handler 已返回', request: { ...rejected.request!, updateId: 'update-b' }, result });
  const returned = receipt().querySelector('pre[aria-label="Update handler 返回结果"]')!;
  assert.deepEqual(JSON.parse(returned.textContent!), result);
  assert.equal(document.querySelector('[data-observation="update-events"]')!.getAttribute('data-status'), 'unknown', '回执不能补造尚未读取的 History');
  await render({ ...rejected, runId: 'other-run', result });
  assert.equal(receipt().getAttribute('data-status'), 'unknown');
  assert.equal(receipt().querySelector('pre'), null);
});

test('源码证据接收 App 的新鲜度状态，整次详情失败时 History 和账本一并过期', async (t) => {
  const page = await browser(t);
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [{ workflowId, runId, status: 'RUNNING', startedAt: observedAt }] }));
  let requests = 0;
  t.mock.method(api, 'getOrder', async () => {
    if (++requests > 1) throw new Error('详情不可用');
    const current = waitingDetail();
    current.history = [{ id: '1', type: 'WorkflowExecutionStarted', category: 'workflow', timestamp: observedAt, label: '工作流已启动' }];
    return current;
  });
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  await page.click(page.button('源码与证据')!);
  const document = page.dom.window.document;
  const select = document.querySelector<HTMLSelectElement>('.source-topic select')!;
  await act(async () => {
    select.value = 'idempotency';
    select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  });
  assert.equal(document.querySelector('[data-observation="history"]')!.getAttribute('data-status'), 'observed');
  assert.equal(document.querySelector('[data-observation="payment"]')!.getAttribute('data-status'), 'observed');
  await page.tick(1_500);
  for (const id of ['history', 'business', 'execution', 'payment']) {
    assert.equal(document.querySelector(`[data-observation="${id}"]`)!.getAttribute('data-status'), 'stale');
  }
  await page.click(page.button('事件历史')!);
  assert.match(document.querySelector('.event-view .inspector-stale')!.textContent!, /上次响应/);
});

test('在线学习独立推演、切换重置且不会请求真实 API', async (t) => {
  const page = await browser(t);
  page.dom.window.history.replaceState(null, '', '#view=walkthrough&chapter=start');
  page.dom.window.localStorage.setItem('temporal4l.read-chapters.v1', JSON.stringify(['start', 'retired-chapter']));
  let requests = 0;
  for (const method of ['getHealth', 'getOrders', 'getOrder', 'createOrder'] as const) {
    t.mock.method(api, method, async () => { requests += 1; throw new Error('在线学习不能调用真实 API'); });
  }
  const skipLink = page.dom.window.document.createElement('a');
  skipLink.className = 'skip-link';
  skipLink.href = '#main-content';
  page.dom.window.document.body.prepend(skipLink);
  const { default: OnlineLearning } = await import('../src/components/OnlineLearning');
  await act(async () => page.root.render(createElement(OnlineLearning)));
  const click = await page.click(skipLink);
  assert.equal(click.defaultPrevented, true, '跳过链接必须取消默认导航，保留课程地址');
  assert.equal(page.dom.window.location.hash, '#view=walkthrough&chapter=start');
  assert.equal(page.dom.window.document.activeElement?.id, 'main-content');
  const document = page.dom.window.document;
  assert.match(document.body.textContent!, /教学示意 · 非真实运行/);
  assert.match(document.body.textContent!, /没有运行 Temporal 后端/);
  for (const [label, url] of [['真实演示', 'http://localhost:5173/'], ['Temporal UI', 'http://localhost:8233/namespaces/temporal-learning/workflows']]) {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('.study-topnav a')].find((item) => item.textContent === label);
    assert.ok(link, `顶部应提供${label}入口`);
    assert.equal(link.href, url);
    assert.equal(link.target, '_blank');
    assert.ok(link.relList.contains('noreferrer'));
    assert.match(document.getElementById(link.getAttribute('aria-describedby')!)!.textContent!, /当前设备.*需先在电脑启动/);
  }
  assert.match(document.querySelector('.study-reading-state')!.textContent!, /已标记读过 1 \/ 7/);
  assert.deepEqual(JSON.parse(page.dom.window.localStorage.getItem('temporal4l.read-chapters.v1')!), ['start', 'retired-chapter']);
  assert.equal((page.button('上一步') as HTMLButtonElement).disabled, true);
  await page.click(page.button('下一步')!);
  assert.match(document.querySelector('.online-step-detail h3')!.textContent!, /Activity/);
  await page.click(document.querySelector('input[value="recovery"]'));
  assert.equal((page.button('上一步') as HTMLButtonElement).disabled, true);
  assert.match(document.querySelector('.online-step-detail h3')!.textContent!, /保存基线/);
  const steps = document.querySelectorAll('.online-steps button');
  await page.click(steps[steps.length - 1]);
  assert.equal((page.button('下一步') as HTMLButtonElement).disabled, true);
  await page.click(page.button('重新推演')!);
  assert.equal(document.querySelector('[aria-current="step"]')?.textContent, '01先保存基线');
  await act(async () => {
    page.dom.window.history.pushState(null, '', '#view=notes&chapter=start');
    page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent('hashchange'));
  });
  assert.equal(document.querySelectorAll('.self-check-question').length, 10);
  assert.ok(document.querySelector('a[href="#view=setup&chapter=start"]'));
  assert.equal(document.querySelectorAll('.connection-pill, .order-builder').length, 0);
  await act(async () => {
    page.dom.window.history.pushState(null, '', '#view=setup&chapter=start');
    page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent('hashchange'));
  });
  assert.equal(document.querySelector('.study-setup a[href="http://localhost:5173/"]')?.getAttribute('target'), '_blank');
  assert.equal(document.querySelector('.study-setup a[href="http://localhost:8233/namespaces/temporal-learning/workflows"]')?.getAttribute('target'), '_blank');
  assert.match(document.querySelector('.study-setup')!.textContent!, /手机上的 localhost 指手机自身/);
  await act(async () => {
    page.dom.window.history.replaceState(null, '', '/');
    page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent('hashchange'));
  });
  assert.match(document.querySelector('h1')!.textContent!, /从这里开始/);
  assert.equal(document.querySelector('.study-view-nav [aria-current]')?.textContent, '阅读课程');
  assert.equal(requests, 0);
});

test('实验工作区切换保留表单与禁用存储时的草稿，支持标签键盘操作和返回导航', async (t) => {
  const page = await browser(t);
  t.mock.method(page.dom.window.Storage.prototype, 'getItem', () => { throw new Error('blocked'); });
  t.mock.method(page.dom.window.Storage.prototype, 'setItem', () => { throw new Error('blocked'); });
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [] }));
  const create = t.mock.method(api, 'createOrder', async () => ({ workflowId, runId }));
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  const document = page.dom.window.document;
  await page.click(document.getElementById('lab-mode-tab-setup'));
  const customer = document.getElementById('customerName') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(customer, '我的学习订单'); customer.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); });
  await page.click(document.getElementById('lab-setup-tab-history'));
  assert.equal(document.getElementById('lab-setup-panel-create')!.hidden, true);
  await act(async () => document.getElementById('lab-setup-tab-history')!.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  assert.equal(document.activeElement?.id, 'lab-setup-tab-create');
  assert.equal(document.getElementById('lab-setup-panel-create')!.hidden, false);
  assert.equal(customer.value, '我的学习订单');
  await page.click(document.getElementById('lab-mode-tab-run'));
  await page.click(document.getElementById('lab-mode-tab-inspect'));
  await page.click(document.getElementById('lab-mode-tab-setup'));
  assert.equal(document.getElementById('customerName'), customer);
  assert.equal(customer.value, '我的学习订单', '切换实验任务不丢失表单');
  await page.click(document.querySelector('.lab-navigation a[href="#learning-practice"]'));
  const answer = document.querySelector<HTMLTextAreaElement>('[id$="-answer-roles"]')!;
  const setAnswer = Object.getOwnPropertyDescriptor(page.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setAnswer.call(answer, '保留我的预测'); answer.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); });
  await page.click(document.querySelector('.lab-navigation a[href="#lab"]'));
  await page.click(document.querySelector('.lab-navigation a[href="#learning-practice"]'));
  assert.equal(document.querySelector('[id$="-answer-roles"]'), answer, '切换后仍是同一个编辑节点');
  assert.equal(answer.value, '保留我的预测');
  assert.equal(customer.value, '我的学习订单');
  await act(async () => { page.dom.window.history.replaceState(null, '', '#lab'); page.dom.window.dispatchEvent(new page.dom.window.PopStateEvent('popstate')); });
  assert.equal(document.getElementById('lab')!.hidden, false);
  assert.equal(document.getElementById('learning-practice')!.closest('.lab-workspace')!.hasAttribute('hidden'), true);
  await act(async () => { page.dom.window.history.replaceState(null, '', '#customerName'); page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent('hashchange')); });
  assert.equal(document.activeElement, customer);
  assert.equal(customer.tabIndex, 0, '错误锚点聚焦输入后仍需保留正常 Tab 顺序');
  assert.equal(create.mock.calls.length, 0);
});

test('空态进入准备实验，创建失败保留输入，创建或选择成功转入观察', async (t) => {
  const page = await browser(t);
  let created = false;
  let attempts = 0;
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: created ? [{ workflowId, runId, status: 'RUNNING', startedAt: observedAt }] : [] }));
  t.mock.method(api, 'getOrder', async () => waitingDetail());
  const create = t.mock.method(api, 'createOrder', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('暂时无法启动订单');
    created = true;
    return { workflowId, runId };
  });
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  const document = page.dom.window.document;
  assert.equal(document.getElementById('lab')!.dataset.view, 'run');
  await page.click(page.button('准备第一条实验订单')!);
  assert.equal(document.getElementById('lab')!.dataset.view, 'setup');
  assert.equal(document.activeElement?.id, 'create-order-title');
  const customer = document.getElementById('customerName') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(customer, '创建交互验收');
    customer.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  });
  await page.click(page.button('启动订单 Workflow')!);
  assert.equal(document.getElementById('lab')!.dataset.view, 'setup');
  assert.match(document.querySelector('.order-form')!.textContent!, /暂时无法启动订单/);
  assert.equal(customer.value, '创建交互验收');
  await page.click(page.button('启动订单 Workflow')!);
  assert.equal(create.mock.calls.length, 2);
  assert.equal(document.getElementById('lab')!.dataset.view, 'run');
  assert.equal(document.activeElement?.id, 'workflow-path-title');
  assert.equal(document.querySelector('.inspector [role="tab"][aria-selected="true"]')?.textContent?.trim(), '事件历史0');
  await page.tick(4_000);
  await page.click(document.getElementById('lab-mode-tab-setup'));
  assert.equal(document.getElementById('customerName'), customer);
  assert.equal(customer.value, '创建交互验收');
  await page.click(document.getElementById('lab-setup-tab-history'));
  await page.click(document.querySelector('.history-item'));
  assert.equal(document.getElementById('lab')!.dataset.view, 'run');
  assert.equal(document.activeElement?.id, 'workflow-path-title');
});

for (const [target, view] of [
  ['recent-orders-title', 'setup'],
  ['workflow-path-title', 'run'],
  ['inspector-title', 'inspect'],
] as const) {
  test(`旧锚点 #${target} 首次进入及返回时显示并聚焦对应面板`, async (t) => {
    const page = await browser(t);
    page.dom.window.history.replaceState(null, '', `#${target}`);
    t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
    t.mock.method(api, 'getOrders', async () => ({ orders: [] }));
    const { default: App } = await import('../src/App');
    await act(async () => page.root.render(createElement(App)));
    const document = page.dom.window.document;
    function assertTarget() {
      assert.equal(document.getElementById('lab')!.hidden, false);
      assert.equal(document.getElementById(`lab-mode-panel-${view}`)!.hidden, false);
      assert.equal(document.getElementById('lab')!.dataset.view, view);
      if (view === 'setup') assert.equal(document.getElementById('lab-setup-panel-history')!.hidden, false);
      assert.equal(document.activeElement?.id, target);
      assert.equal(document.getElementById(`lab-mode-tab-${view}`)!.getAttribute('aria-pressed'), 'true');
    }
    assertTarget();
    await page.click(document.getElementById('lab-mode-tab-setup'));
    await page.click(document.getElementById('lab-setup-tab-create'));
    await page.click(document.getElementById('lab-mode-tab-inspect'));
    await page.click(document.querySelector('.lab-navigation a[href="#learning-practice"]'));
    await act(async () => {
      page.dom.window.history.replaceState(null, '', `#${target}`);
      page.dom.window.dispatchEvent(new page.dom.window.PopStateEvent('popstate'));
    });
    assertTarget();
  });
}

test('恢复工作区隐藏后仍保留同 Run 基线并累计停机证据，不移动笔记焦点', async (t) => {
  const page = await browser(t);
  let current = waitingDetail();
  current.history = [{ id: '9', type: 'WorkflowTaskCompleted', category: 'workflow', timestamp: observedAt, label: '任务完成' }];
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [{ workflowId, runId, status: 'RUNNING', startedAt: observedAt }] }));
  t.mock.method(api, 'getOrder', async () => current);
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  const document = page.dom.window.document;
  await page.click(document.querySelector('.lab-navigation a[href="#recovery"]'));
  await page.click(page.button('保存实验前快照')!);
  assert.match(document.querySelector('.recovery-baseline')!.textContent!, new RegExp(runId));
  await page.click(page.button('已在终端停止 Worker')!);
  await page.click(document.querySelector('.lab-navigation a[href="#learning-practice"]'));
  const answer = document.querySelector<HTMLTextAreaElement>('[id$="-answer-roles"]')!;
  answer.focus();
  current = { ...current, state: null, stateError: 'Worker 已停止，Query 不可用', observedAt: '2026-10-27T10:00:01.000Z' };
  await page.tick(1_500);
  assert.equal(document.activeElement, answer);
  await page.click(document.querySelector('.lab-navigation a[href="#recovery"]'));
  assert.match(document.querySelector('.recovery-observations')!.textContent!, /已固定 History 边界 #9/);
  assert.match(document.querySelector('.recovery-baseline')!.textContent!, new RegExp(runId));
  assert.match(document.querySelector('.lab-navigation')!.textContent!, /观察中/);
});

test('当前运行切换视图保留 Update 选择与未知结果，回执恢复仍绑定原请求', async (t) => {
  const page = await browser(t);
  t.mock.method(api, 'getHealth', async () => ({ temporal: true, worker: true, namespace: 'test', taskQueue: 'test', temporalUiUrl: 'http://localhost:8233' }));
  t.mock.method(api, 'getOrders', async () => ({ orders: [{ workflowId, runId, status: 'RUNNING', startedAt: observedAt }] }));
  t.mock.method(api, 'getOrder', async () => waitingDetail());
  const update = t.mock.method(api, 'approveOrderUpdate', async () => { throw new Error('等待结果超时'); });
  const lookup = t.mock.method(api, 'getApprovalUpdate', async () => { throw new Error('仍未取得结果'); });
  const { default: App } = await import('../src/App');
  await act(async () => page.root.render(createElement(App)));
  const document = page.dom.window.document;
  await page.click(page.button('前往确认')!);
  assert.equal(document.getElementById('run-view-panel-actions')!.hidden, false);
  assert.equal(document.activeElement?.id, 'run-view-tab-actions', '提示按钮隐藏后焦点应移到已显示的操作标签');
  await page.click(document.querySelector('input[value="update"]'));
  await page.click(document.querySelector('.approval-validation input'));
  const scroller = document.querySelector<HTMLElement>('.workflow-scroll')!;
  scroller.scrollTop = 180;
  await page.tick(1_500);
  assert.equal(scroller.scrollTop, 180, '同一 Run 的轮询不打断阅读');
  await page.click(document.getElementById('run-view-tab-steps'));
  assert.equal(scroller.scrollTop, 0, '主动切换运行子页从顶部开始');
  await page.click(document.getElementById('run-view-tab-actions'));
  assert.equal(document.querySelector<HTMLInputElement>('input[value="update"]')!.checked, true);
  assert.equal(document.querySelector<HTMLInputElement>('.approval-validation input')!.checked, true);
  await page.click(page.button('发送确认 Update')!);
  assert.equal(update.mock.calls.length, 1);
  const confirmation = document.querySelector('.approval-validation input');
  await page.click(document.getElementById('lab-mode-tab-setup'));
  await page.click(document.getElementById('lab-mode-tab-inspect'));
  await page.click(document.getElementById('lab-mode-tab-run'));
  assert.equal(document.querySelector('.approval-validation input'), confirmation, '切换任务模式保留同一确认组件');
  assert.match(document.querySelector('.approval-feedback')!.textContent!, /Update ID/);
  await page.click(document.getElementById('run-view-tab-effects'));
  assert.match(document.querySelector('.run-action-prompt')!.textContent!, /Update 结果未知/);
  await page.click(page.button('查看恢复操作')!);
  assert.match(document.querySelector('.approval-feedback')!.textContent!, /Update ID/);
  await page.click(page.button('查询原 Update 结果')!);
  const request = update.mock.calls[0].arguments as unknown as [string, { updateId: string; runId: string; confirmed: boolean }];
  assert.deepEqual(lookup.mock.calls[0].arguments, [workflowId, runId, request[1].updateId]);
  assert.equal(update.mock.calls.length, 1, '查询原结果不能新建确认请求');
});

test('Temporal 超时执行的文案、色调和终态保持一致', () => {
  for (const status of ['TIMED_OUT', 'timed-out', 'Timed Out', 'timedout']) {
    assert.equal(orderStatusLabel(status), '已超时');
    assert.equal(orderStatusTone(status), 'danger');
    assert.equal(isTerminalExecutionStatus(status), true);
  }
  assert.equal(orderStatusTone('RUNNING'), 'running');
  assert.equal(orderStatusTone('COMPLETED'), 'success');
});

test('切换到固定超时场景时清除已被自动修正的期限错误', async (t) => {
  const page = await browser(t);
  const { OrderForm } = await import('../src/components/OrderForm');
  await act(async () => page.root.render(createElement(OrderForm, {
    connected: true, pending: false, requestError: null, onSubmit: async () => {},
  })));
  const timeout = page.dom.window.document.getElementById('approvalTimeoutSeconds') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(timeout, '0');
    timeout.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  });
  await page.click(page.button('启动订单 Workflow')!);
  assert.equal(timeout.getAttribute('aria-invalid'), 'true');
  await page.click(page.dom.window.document.querySelector('input[value="timeout"]'));
  assert.equal(timeout.value, '15');
  assert.equal(timeout.readOnly, true);
  assert.equal(timeout.getAttribute('aria-invalid'), 'false');
  assert.equal(page.dom.window.document.getElementById('approvalTimeoutSeconds-error'), null);
  assert.ok(page.dom.window.document.getElementById('customerName-error'), '自动修正期限不应清除姓名错误');
});
