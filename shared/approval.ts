import type { ApprovalUpdateRequest, ApprovalUpdateResult } from './types';

export interface ApprovalUpdateUnknown {
  workflowId: string;
  runId: string;
  updateId: string;
  status: 'unknown';
  message: string;
}

export type ApprovalUpdateResponse = ApprovalUpdateResult | ApprovalUpdateUnknown;

export interface ApprovalFeedback {
  workflowId: string;
  runId: string;
  method: 'signal' | 'update';
  status: 'sent' | 'approved' | 'rejected' | 'unknown';
  message: string;
  request?: ApprovalUpdateRequest;
  result?: ApprovalUpdateResult;
}
