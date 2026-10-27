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
      await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
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

  await page.click(page.button('展开学习路线')!);
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
  const toggle = page.button('展开自测与练习')!;
  const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  assert.equal(body.hidden, true);
  await page.click(toggle);
  assert.equal(body.hidden, false);
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
  let requests = 0;
  for (const method of ['getHealth', 'getOrders', 'getOrder', 'createOrder'] as const) {
    t.mock.method(api, method, async () => { requests += 1; throw new Error('在线学习不能调用真实 API'); });
  }
  const { default: OnlineLearning } = await import('../src/components/OnlineLearning');
  await act(async () => page.root.render(createElement(OnlineLearning)));
  const document = page.dom.window.document;
  assert.match(document.body.textContent!, /教学示意 · 非真实运行/);
  assert.match(document.body.textContent!, /没有运行 Temporal 后端/);
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
  await page.click(page.button('展开自测与练习')!);
  assert.equal(document.querySelectorAll('.self-check-question').length, 10);
  assert.ok(document.querySelector('a[href="#local-lab"]'));
  assert.equal(document.querySelectorAll('.connection-pill, .order-builder').length, 0);
  assert.equal(requests, 0);
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
