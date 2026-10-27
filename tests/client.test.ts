import assert from 'node:assert/strict';
import test from 'node:test';
import { Connection } from '@temporalio/client';
import { closeClient, getClient, TemporalConnectionError } from '../server/client';

// 在 SDK 边界模拟 readiness，保留真正的 gRPC channel 和 close。
test('连接 readiness 失败会关闭 channel，并允许并发请求共享下一次重试', async (t) => {
  const lazy = Connection.lazy;
  const closed = new Set<Connection>();
  const created: Connection[] = [];
  const failure = new Error('Failed to connect before the deadline');
  t.mock.method(Connection, 'lazy', (options: Parameters<typeof Connection.lazy>[0]) => {
    const connection = lazy.call(Connection, options);
    created.push(connection);
    const attempt = created.length;
    t.mock.method(connection, 'ensureConnected', async () => {
      if (attempt === 1) throw failure;
    });
    const close = connection.close.bind(connection);
    t.mock.method(connection, 'close', async () => {
      closed.add(connection);
      await close();
    });
    return connection;
  });
  t.after(async () => {
    await closeClient();
    await Promise.all(created.map((connection) => connection.close()));
  });

  const first = getClient();
  assert.equal(getClient(), first);
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof TemporalConnectionError);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(closed.has(created[0]), true, '失败的连接必须关闭，不能在重试时丢失 channel 引用');

  const retry = getClient();
  assert.equal(getClient(), retry);
  const client = await retry;
  assert.equal(created.length, 2);
  assert.equal(client.connection, created[1]);
  assert.equal(closed.has(created[1]), false);
  await closeClient();
  assert.equal(closed.has(created[1]), true);
  const reopened = await getClient();
  assert.equal(created.length, 3, '关闭后重新连接，不能复用已关闭的 client');
  assert.equal(reopened.connection, created[2]);
});

test('关闭客户端会等待正在建立的连接并释放它，关闭完成后可以重新连接', async (t) => {
  const lazy = Connection.lazy;
  const created: Connection[] = [];
  const closed = new Set<Connection>();
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => { ready = resolve; });
  t.mock.method(Connection, 'lazy', (options: Parameters<typeof Connection.lazy>[0]) => {
    const connection = lazy.call(Connection, options);
    created.push(connection);
    t.mock.method(connection, 'ensureConnected', () => created.length === 1 ? readiness : Promise.resolve());
    const close = connection.close.bind(connection);
    t.mock.method(connection, 'close', async () => {
      closed.add(connection);
      await close();
    });
    return connection;
  });
  t.after(async () => {
    ready();
    await closeClient();
    await Promise.all(created.map((connection) => connection.close()));
  });

  const connecting = getClient();
  let stopped = false;
  const stopping = closeClient().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closedBeforeReady = stopped;
  ready();
  await Promise.all([connecting, stopping]);
  assert.equal(closedBeforeReady, false, '关闭必须覆盖 pending 连接的资源，不能提前完成');
  assert.equal(closed.has(created[0]), true);

  const reopened = await getClient();
  assert.equal(created.length, 2);
  assert.equal(reopened.connection, created[1]);
});
