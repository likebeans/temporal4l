import type {
  ApprovalSignalResponse,
  ApprovalUpdateRequest,
  CreateOrderResponse,
  HealthResponse,
  OrderDetail,
  OrderInput,
  OrderSummary,
} from '../shared/types';
import type { ApprovalUpdateResponse } from '../shared/approval';

interface OrdersResponse {
  orders: OrderSummary[];
}

interface ErrorPayload {
  error?: string;
  message?: string;
  status?: string;
  failureType?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly outcome?: string;
  readonly failureType?: string;

  constructor(message: string, status: number, payload?: ErrorPayload | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.outcome = payload?.status;
    this.failureType = payload?.failureType;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  const rawBody = await response.text();
  let body: unknown;

  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      body = rawBody;
    }
  }

  if (!response.ok) {
    const payload = typeof body === 'object' && body !== null ? (body as ErrorPayload) : null;
    const message =
      payload?.error ??
      payload?.message ??
      (typeof body === 'string' && body.trim() ? body : `请求失败（HTTP ${response.status}）`);
    throw new ApiError(message, response.status, payload);
  }

  return body as T;
}

function workflowPath(workflowId: string): string {
  return `/api/orders/${encodeURIComponent(workflowId)}`;
}

export const api = {
  getHealth(signal?: AbortSignal) {
    return request<HealthResponse>('/api/health', { signal });
  },
  getOrders(signal?: AbortSignal) {
    return request<OrdersResponse>('/api/orders', { signal });
  },
  createOrder(input: OrderInput, signal?: AbortSignal) {
    return request<CreateOrderResponse>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
  },
  getOrder(workflowId: string, signal?: AbortSignal) {
    return request<OrderDetail>(workflowPath(workflowId), { signal });
  },
  approveOrder(workflowId: string, signal?: AbortSignal) {
    return request<ApprovalSignalResponse>(`${workflowPath(workflowId)}/approve`, {
      method: 'POST',
      signal,
    });
  },
  approveOrderUpdate(workflowId: string, input: ApprovalUpdateRequest) {
    return request<ApprovalUpdateResponse>(`${workflowPath(workflowId)}/approval-updates`, {
      method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
    });
  },
  getApprovalUpdate(workflowId: string, runId: string, updateId: string) {
    return request<ApprovalUpdateResponse>(
      `${workflowPath(workflowId)}/approval-updates/${encodeURIComponent(updateId)}?runId=${encodeURIComponent(runId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
  },
  cancelOrder(workflowId: string, signal?: AbortSignal) {
    return request<unknown>(`${workflowPath(workflowId)}/cancel`, {
      method: 'POST',
      signal,
    });
  },
};

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return '无法连接本地 API，请确认开发服务已启动。';
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return '发生未知错误，请稍后重试。';
}
