import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  ServiceError, WorkflowNotFoundError, WorkflowUpdateFailedError, WorkflowUpdateRPCTimeoutOrCancelledError,
} from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import {
  APPROVE_SIGNAL, APPROVE_UPDATE, STATE_QUERY, TASK_QUEUE, WORKFLOW_ID_PREFIX, WORKFLOW_TYPE,
  type ApprovalSignalResponse, type ApprovalUpdateRequest, type ApprovalUpdateResult,
  type HealthResponse, type OrderDetail, type OrderInput, type OrderState, type OrderSummary,
} from '../shared/types';
import type { ApprovalUpdateUnknown } from '../shared/approval';
import { closeClient, TemporalConnectionError, withTemporal } from './client';
import { config } from './config';
import { presentHistory } from './history';
import { presentPendingActivities } from './pending-activities';
import { closePaymentStore, getPaymentStore } from './payment-ledger';
import { createOrderSchema, isDemoWorkflowId, normalizeOrder } from './validation';

const app = Fastify({
  logger: { level: 'info' },
  ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
});

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});

app.setErrorHandler<FastifyError>((error, request, reply) => {
  if (error.validation) {
    const message = request.routeOptions.url?.includes('/approval-updates')
      ? 'Update 参数不合法：请提供布尔 confirmed，以及 UUID 格式的 runId 和 updateId。'
      : '请求参数不合法，请检查订单信息和运行标识。';
    return reply.code(400).send({ message });
  }
  if (error instanceof WorkflowNotFoundError) {
    return reply.code(404).send({ message: '没有找到这个订单工作流。' });
  }
  request.log.error(error);
  const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 503;
  return reply.code(status).send({
    message: status < 500 ? error.message : 'Temporal 暂时不可用，请确认服务和 Worker 已启动，再重试。',
  });
});

app.get('/api/health', async (): Promise<HealthResponse> => {
  const base = {
    namespace: config.namespace,
    taskQueue: TASK_QUEUE,
    temporalUiUrl: config.temporalUiUrl,
  };
  try {
    return await withTemporal(async (client) => {
      await client.workflowService.describeNamespace({ namespace: config.namespace });
      const queue = await client.workflowService.describeTaskQueue({
        namespace: config.namespace,
        taskQueue: { name: TASK_QUEUE },
        taskQueueType: 1,
      });
      // Poller 信息有短暂滞后；它表示最近 90 秒内 Worker 曾拉取任务。
      const worker = (queue.pollers ?? []).some((poller) => {
        const seconds = Number(poller.lastAccessTime?.seconds?.toString() ?? 0);
        return Date.now() - seconds * 1_000 < 90_000;
      });
      return { ...base, temporal: true, worker };
    });
  } catch {
    return { ...base, temporal: false, worker: false, message: 'Temporal 未连接：原生方式运行 npm run temporal:local；Docker 方式运行 npm run temporal:up。请选择一种并核对连接地址与 namespace。' };
  }
});

app.get('/api/orders', async () => withTemporal(async (client) => {
  const orders: OrderSummary[] = [];
  // 使用专用 namespace 的 Visibility 列表；不依赖进程内存，API 重启后仍能查询。
  const workflows = client.workflow.list({
    // SQLite Visibility 使用默认 StartTime 降序，不支持显式 ORDER BY。
    query: `WorkflowType = '${WORKFLOW_TYPE}'`,
    pageSize: 50,
  });
  for await (const workflow of workflows) {
    if (!isDemoWorkflowId(workflow.workflowId)) continue;
    orders.push({
      workflowId: workflow.workflowId,
      runId: workflow.runId,
      status: workflow.status.name,
      startedAt: workflow.startTime.toISOString(),
      ...(workflow.closeTime ? { closedAt: workflow.closeTime.toISOString() } : {}),
    });
    if (orders.length >= 50) break;
  }
  return { orders };
}));

app.post<{ Body: OrderInput }>('/api/orders', {
  schema: { body: createOrderSchema },
}, async (request, reply) => withTemporal(async (client) => {
  const workflowId = `${WORKFLOW_ID_PREFIX}${randomUUID()}`;
  const input = normalizeOrder(request.body);
  const handle = await client.workflow.start(WORKFLOW_TYPE, {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
    // 禁止不小心复用相同 ID；业务 Activity 的重试策略定义在 workflows.ts 中。
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });
  return reply.code(201).send({ workflowId, runId: handle.firstExecutionRunId });
}));

const uuidSchema = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const approvalUpdateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'updateId', 'confirmed'],
  properties: { runId: uuidSchema, updateId: uuidSchema, confirmed: { type: 'boolean' } },
};

function unknownUpdate(workflowId: string, runId: string, updateId: string): ApprovalUpdateUnknown {
  return {
    workflowId, runId, updateId, status: 'unknown',
    message: '请求等待已结束，Update 的结果暂时未知；它可能仍在处理。请用原 Run ID 和 Update ID 查询结果，或重试同一请求。',
  };
}

const orderParamsSchema = {
  type: 'object',
  required: ['workflowId'],
  properties: { workflowId: { type: 'string' } },
};

type OrderParams = { workflowId: string };
app.addHook('preHandler', async (request, reply) => {
  if (request.routeOptions.url?.startsWith('/api/orders/:')) {
    const { workflowId } = request.params as OrderParams;
    if (!isDemoWorkflowId(workflowId)) {
      return reply.code(400).send({ message: '只能查看或操作本示例创建的订单工作流。' });
    }
  }
});

app.get<{ Params: OrderParams }>('/api/orders/:workflowId', {
  schema: { params: orderParamsSchema },
}, async (request): Promise<OrderDetail> => withTemporal(async (client) => {
  // Describe 与 Query 共用前 4 秒，为 History 保留外层 6 秒 deadline 的余量。
  const queryDeadline = Date.now() + 4_000;
  const { workflowId } = request.params;
  const currentHandle = client.workflow.getHandle(workflowId);
  const description = await currentHandle.describe();
  const handle = client.workflow.getHandle(workflowId, description.runId);
  const stateResult = await client.connection.withDeadline(queryDeadline, () => handle.query<OrderState>(STATE_QUERY)).then(
    (state) => ({ state, stateError: undefined }),
    () => ({ state: null, stateError: '状态 Query 暂不可用：工作流可能尚未初始化，或 Worker 尚未就绪。' }),
  );
  // Query 结束后再读 History，让失败响应也包含等待期间收到的 Signal。
  const history = await handle.fetchHistory();
  return {
    workflowId,
    runId: description.runId,
    status: description.status.name,
    state: stateResult.state,
    ...(stateResult.stateError ? { stateError: stateResult.stateError } : {}),
    history: presentHistory(history.events ?? []),
    observedAt: new Date().toISOString(),
    pendingActivities: presentPendingActivities(description.raw.pendingActivities ?? []),
    payment: getPaymentStore().get(workflowId),
  };
}));

app.post<{ Params: OrderParams }>('/api/orders/:workflowId/approve', async (request, reply) =>
  withTemporal(async (client) => {
    const { workflowId } = request.params;
    const description = await client.workflow.getHandle(workflowId).describe();
    if (description.status.name !== 'RUNNING') {
      return reply.code(409).send({ message: '工作流已经结束，无法再确认。' });
    }
    const handle = client.workflow.getHandle(workflowId, description.runId);
    const state = await handle.query<OrderState>(STATE_QUERY);
    if (state.status !== 'waiting_approval' || state.approvedAt) {
      return reply.code(409).send({ message: '订单当前没有等待人工确认，请刷新状态。' });
    }
    await handle.signal(APPROVE_SIGNAL);
    return {
      workflowId, runId: description.runId, status: 'sent',
      message: 'Temporal 已接收确认 Signal；这只是收件回执，请继续观察 Query 和事件历史确认是否已处理。',
    } satisfies ApprovalSignalResponse;
  }));

app.post<{ Params: OrderParams; Body: ApprovalUpdateRequest }>('/api/orders/:workflowId/approval-updates', {
  schema: { body: approvalUpdateSchema },
}, async (request, reply) => {
  const { workflowId } = request.params;
  const { runId, updateId, confirmed } = request.body;
  try {
    // 不用 Query 预检查替代 validator；业务校验和修改都在 Workflow 内完成。
    return await withTemporal((client) => client.workflow.getHandle(workflowId, runId)
      .executeUpdate<ApprovalUpdateResult, [{ confirmed: boolean }]>(APPROVE_UPDATE, {
        args: [{ confirmed }], updateId,
      }));
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      const cause = error.cause;
      return reply.code(409).send({
        workflowId, runId, updateId, status: 'rejected',
        failureType: cause instanceof ApplicationFailure ? cause.type : undefined,
        message: cause?.message || 'Update 未能完成确认，请检查订单状态。',
      });
    }
    if (error instanceof TemporalConnectionError || error instanceof WorkflowUpdateRPCTimeoutOrCancelledError
      || error instanceof ServiceError) {
      return reply.code(202).send(unknownUpdate(workflowId, runId, updateId));
    }
    throw error;
  }
});

app.get<{ Params: OrderParams & { updateId: string }; Querystring: { runId: string } }>(
  '/api/orders/:workflowId/approval-updates/:updateId', {
    schema: {
      params: {
        type: 'object', required: ['workflowId', 'updateId'],
        properties: { workflowId: { type: 'string' }, updateId: uuidSchema },
      },
      querystring: {
        type: 'object', additionalProperties: false, required: ['runId'], properties: { runId: uuidSchema },
      },
    },
  }, async (request, reply) => {
    const { workflowId, updateId } = request.params;
    const { runId } = request.query;
    try {
      return await withTemporal((client) => client.workflow.getHandle(workflowId, runId)
        .getUpdateHandle<ApprovalUpdateResult>(updateId).result());
    } catch (error) {
      if (error instanceof WorkflowUpdateFailedError) {
        return reply.code(409).send({
          workflowId, runId, updateId, status: 'rejected',
          message: error.cause?.message || 'Update handler 执行失败。',
        });
      }
      if (error instanceof TemporalConnectionError || error instanceof WorkflowUpdateRPCTimeoutOrCancelledError
        || error instanceof ServiceError || error instanceof WorkflowNotFoundError) {
        // 未找到也不能推断之前的 HTTP 请求已被取消；拒绝的 Update 不保留可查询结果。
        return reply.code(202).send(unknownUpdate(workflowId, runId, updateId));
      }
      throw error;
    }
  },
);

app.post<{ Params: OrderParams }>('/api/orders/:workflowId/cancel', async (request, reply) =>
  withTemporal(async (client) => {
    const handle = client.workflow.getHandle(request.params.workflowId);
    if ((await handle.describe()).status.name !== 'RUNNING') {
      return reply.code(409).send({ message: '工作流已经结束，无需取消。' });
    }
    // 使用 cooperative cancellation，让 Workflow 有机会退款和释放库存。
    await handle.cancel();
    return { message: '取消请求已交给 Temporal，正在等待工作流完成补偿。' };
  }));

const distPath = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) return reply.code(404).send({ message: '接口不存在。' });
    return reply.sendFile('index.html');
  });
}

app.addHook('onClose', closeClient);
app.addHook('onClose', async () => { closePaymentStore(); });
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().catch((error: unknown) => {
        app.log.error(error);
        process.exitCode = 1;
      });
    });
  }

  await app.listen({ host: '127.0.0.1', port: config.port });
}
