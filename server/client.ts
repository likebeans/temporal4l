import { Client, Connection } from '@temporalio/client';
import { config } from './config';

export class TemporalConnectionError extends Error {
  constructor(cause: unknown) {
    super('连接 Temporal 失败。', { cause });
    this.name = 'TemporalConnectionError';
  }
}

let pendingClient: Promise<Client> | undefined;
let closingClient: Promise<void> | undefined;

// 允许先启动页面，再启动 Temporal；连接失败后下次请求会重新连接。
export function getClient(): Promise<Client> {
  if (closingClient) return closingClient.then(() => getClient());
  pendingClient ??= (async () => {
    const connecting = Connection.lazy({ address: config.address, connectTimeout: '3s' });
    try {
      await connecting.ensureConnected();
      return new Client({ connection: connecting, namespace: config.namespace });
    } catch (error) {
      await connecting.close();
      throw error;
    }
  })().catch((error: unknown) => {
    pendingClient = undefined;
    throw new TemporalConnectionError(error);
  });
  return pendingClient;
}

export function closeClient(): Promise<void> {
  closingClient ??= (async () => {
    try {
      // readiness 失败时 getClient 已关闭 channel；成功时等待完成后再关闭。
      const client = await pendingClient?.catch(() => undefined);
      await client?.connection.close();
    } finally {
      pendingClient = undefined;
      closingClient = undefined;
    }
  })();
  return closingClient;
}

export async function withTemporal<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = await getClient();
  return client.connection.withDeadline(Date.now() + 6_000, () => operation(client));
}
