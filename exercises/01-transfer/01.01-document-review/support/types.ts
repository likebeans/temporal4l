export const DOCUMENT_REVIEW_TASK_QUEUE = 'temporal-learning-document-review';
export const DOCUMENT_REVIEW_WORKFLOW = 'documentReviewWorkflow';
export const APPROVE_DOCUMENT_SIGNAL = 'approveDocument';
export const DOCUMENT_REVIEW_STATE_QUERY = 'documentReviewState';

export interface DocumentReviewInput {
  documentId: string;
  reviewTimeoutSeconds: number;
  losePrepareResponse?: boolean;
}

export type DocumentReviewStatus = 'preparing' | 'waiting_review' | 'archiving' | 'completed'
  | 'cleaning_up' | 'timed_out' | 'cancelled' | 'failed' | 'not_implemented';

export interface DocumentCleanup {
  status: 'idle' | 'running' | 'completed' | 'failed';
  outcome?: 'removed' | 'already_removed' | 'absent';
  error?: string;
}

// 成功时作为返回值；失败/取消通过 result() 抛错，仍可用 Query 观察业务状态。
export interface DocumentReviewState {
  workflowId: string;
  runId: string;
  documentId: string;
  status: DocumentReviewStatus;
  prepareAttempted: boolean;
  prepareCompleted: boolean;
  reviewDeadline?: string;
  approvedAt?: string;
  cleanup: DocumentCleanup;
  error?: string;
}

export interface DocumentActivityArgs {
  workflowId: string;
  documentId: string;
  losePrepareResponse?: boolean;
}

export interface DocumentActivityExecution {
  runId: string;
  activityId: string;
  attempt: number;
}

export interface DocumentReviewActivities {
  prepareDocument(args: DocumentActivityArgs): Promise<{ idempotencyKey: string; reused: boolean }>;
  archiveDocument(args: DocumentActivityArgs): Promise<void>;
  cleanupDocument(args: DocumentActivityArgs): Promise<{ outcome: NonNullable<DocumentCleanup['outcome']> }>;
}

export type DocumentEntryKind = 'prepare_attempt' | 'prepared' | 'reused' | 'response_lost'
  | 'archive_attempt' | 'archived' | 'archive_reused' | 'cleanup_attempt'
  | 'removed' | 'cleanup_reused' | 'cleanup_absent';

export interface DocumentEntry extends DocumentActivityExecution {
  id: number;
  kind: DocumentEntryKind;
  message: string;
  createdAt: string;
}

export interface DocumentLedger {
  workflowId: string;
  idempotencyKey: string;
  document: { documentId: string; status: 'prepared' | 'archived' | 'removed'; content: string | null } | null;
  prepareAttempts: number;
  prepared: number;
  reused: number;
  archived: number;
  removed: number;
  entries: DocumentEntry[];
}

// 返回错误文案，调用方决定使用 CLI Error 还是 Workflow nonretryable failure。
export function documentInputError(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return '输入必须是资料审核对象';
  const value = input as Partial<DocumentReviewInput>;
  if (typeof value.documentId !== 'string' || !/^[\p{L}\p{N}_.-]{1,100}$/u.test(value.documentId)) {
    return 'documentId 应为 1–100 个文字、数字、下划线、点或连字符';
  }
  if (!Number.isInteger(value.reviewTimeoutSeconds)
    || Number(value.reviewTimeoutSeconds) < 1 || Number(value.reviewTimeoutSeconds) > 3_600) {
    return 'reviewTimeoutSeconds 应为 1–3600 的整数';
  }
  if (value.losePrepareResponse !== undefined && typeof value.losePrepareResponse !== 'boolean') {
    return 'losePrepareResponse 应为布尔值';
  }
  return undefined;
}
