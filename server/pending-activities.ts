import type { temporal } from '@temporalio/proto';
import { defaultPayloadConverter } from '@temporalio/common';
import type { PackingCheckpoint, PendingActivity } from '../shared/types';

type RawActivity = temporal.api.workflow.v1.IPendingActivityInfo;

function timestamp(value: temporal.api.workflow.v1.IPendingActivityInfo['lastHeartbeatTime']): string | undefined {
  if (!value) return undefined;
  return new Date(Number(value.seconds?.toString() ?? 0) * 1_000 + (value.nanos ?? 0) / 1_000_000).toISOString();
}

function checkpoint(activity: RawActivity): PackingCheckpoint | undefined {
  const payload = activity.heartbeatDetails?.payloads?.[0];
  if (!payload || activity.activityType?.name !== 'packOrder') return undefined;
  try {
    const value = defaultPayloadConverter.fromPayload<Partial<PackingCheckpoint>>(payload);
    if (!value || typeof value.completedBatches !== 'number' || typeof value.totalBatches !== 'number'
      || typeof value.attempt !== 'number' || typeof value.resumedFrom !== 'number'
      || typeof value.updatedAt !== 'string' || !['packing', 'paused', 'completed'].includes(value.phase ?? '')) {
      return undefined;
    }
    return value as PackingCheckpoint;
  } catch {
    return undefined;
  }
}

export function presentPendingActivities(activities: RawActivity[]): PendingActivity[] {
  const states: Record<number, string> = { 1: 'SCHEDULED', 2: 'STARTED', 3: 'CANCEL_REQUESTED' };
  return activities.map((activity) => ({
    activityId: activity.activityId ?? '',
    activityType: activity.activityType?.name ?? 'Activity',
    state: states[activity.state ?? 0] ?? 'UNKNOWN',
    attempt: activity.attempt ?? 1,
    lastHeartbeatAt: timestamp(activity.lastHeartbeatTime),
    heartbeat: checkpoint(activity),
    lastFailure: activity.lastFailure?.message ?? undefined,
  }));
}
