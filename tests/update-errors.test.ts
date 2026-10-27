import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_ID_PREFIX } from '../shared/types';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

async function startApi(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-update-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unavailable = createServer();
  unavailable.listen(0, '127.0.0.1');
  await once(unavailable, 'listening');
  const address = unavailable.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      API_PORT: '0',
      TEMPORAL_ADDRESS: `127.0.0.1:${address.port}`,
      TEMPORAL_NAMESPACE: `update-errors-${randomUUID()}`,
      PAYMENT_DB_PATH: join(directory, 'payments.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopApi(child));
  let output = '';
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`API 启动超时：${output}`)), 10_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`API 提前退出（${code}）：${output}`)); });
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
}

for (const method of ['POST', 'GET'] as const) {
  test(`真实 HTTP：${method} Update 首次连接失败返回原标识的 unknown，普通接口仍返回 503`, { timeout: 25_000 }, async (t) => {
    const base = await startApi(t);
    const workflowId = `${WORKFLOW_ID_PREFIX}${randomUUID()}`;
    const runId = randomUUID();
    const updateId = randomUUID();
    const path = `/api/orders/${workflowId}/approval-updates`;
    const post = (body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (method === 'POST') {
      for (const body of [
        { runId, updateId, confirmed: 'true' },
        { runId: 'latest', updateId, confirmed: true },
        { runId, updateId: 'bad', confirmed: false },
      ]) assert.equal((await post(body)).status, 400);
    } else {
      assert.equal((await fetch(`${base}${path}/${updateId}?runId=latest`)).status, 400);
      assert.equal((await fetch(`${base}${path}/bad?runId=${runId}`)).status, 400);
    }

    const response = method === 'POST'
      ? await post({ runId, updateId, confirmed: true })
      : await fetch(`${base}${path}/${updateId}?runId=${runId}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 202);
    const result = await response.json() as Record<string, unknown>;
    assert.deepEqual(
      { workflowId: result.workflowId, runId: result.runId, updateId: result.updateId, status: result.status },
      { workflowId, runId, updateId, status: 'unknown' },
    );
    assert.equal(typeof result.message, 'string');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const orders = await fetch(`${base}/api/orders`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(orders.status, 503);
    assert.match((await orders.json() as { message: string }).message, /Temporal 暂时不可用/);
  });
}
