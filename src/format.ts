import { SCENARIOS } from '../shared/types';
import type { OrderStatus, Scenario, StepStatus } from '../shared/types';

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 0,
});

export function formatDateTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

export function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

export function orderStatusLabel(status: string): string {
  const normalized = normalizeStatus(status);
  const labels: Record<string, string> = {
    running: '运行中',
    waiting_approval: '等待确认',
    completed: '已完成',
    failed: '已失败',
    cancelled: '已取消',
    canceled: '已取消',
    terminated: '已终止',
    timed_out: '已超时',
    timedout: '已超时',
    continued_as_new: '已继续为新运行',
  };
  return labels[normalized] ?? status;
}

export function orderStatusTone(status: string): string {
  const normalized = normalizeStatus(status);
  if (normalized.includes('complete')) return 'success';
  if (normalized.includes('wait')) return 'waiting';
  if (normalized.includes('fail') || normalized.includes('timeout') || normalized === 'timed_out' || normalized === 'timedout') return 'danger';
  if (normalized.includes('cancel') || normalized.includes('terminat')) return 'neutral';
  return 'running';
}

export function stepStatusLabel(status: StepStatus): string {
  const labels: Record<StepStatus, string> = {
    pending: '待执行',
    running: '执行中',
    waiting: '等待信号',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status];
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isTerminalExecutionStatus(status: string): boolean {
  return new Set(['completed', 'failed', 'cancelled', 'canceled', 'terminated', 'timed_out', 'timedout']).has(
    normalizeStatus(status),
  );
}

export function scenarioLabel(scenario: Scenario): string {
  return SCENARIOS.find((item) => item.id === scenario)?.label ?? scenario;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
