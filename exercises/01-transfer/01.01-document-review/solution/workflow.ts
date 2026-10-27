import {
  ApplicationFailure,
  CancellationScope,
  CancelledFailure,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  APPROVE_DOCUMENT_SIGNAL,
  DOCUMENT_REVIEW_STATE_QUERY,
  documentInputError,
  type DocumentReviewActivities,
  type DocumentReviewInput,
  type DocumentReviewState,
} from '../support/types';

const approveDocument = defineSignal(APPROVE_DOCUMENT_SIGNAL);
const documentReviewState = defineQuery<DocumentReviewState>(DOCUMENT_REVIEW_STATE_QUERY);
const { prepareDocument, archiveDocument, cleanupDocument } = proxyActivities<DocumentReviewActivities>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  heartbeatTimeout: '3 seconds',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: { maximumAttempts: 2, initialInterval: '2 seconds', backoffCoefficient: 1 },
});

function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause && error.cause !== error
    ? `${error.message}；${failureDetail(error.cause)}` : error.message;
}

export async function documentReviewWorkflow(input: DocumentReviewInput): Promise<DocumentReviewState> {
  const { workflowId, runId } = workflowInfo();
  const state: DocumentReviewState = {
    workflowId,
    runId,
    documentId: input?.documentId,
    status: 'preparing',
    prepareAttempted: false,
    prepareCompleted: false,
    cleanup: { status: 'idle' },
  };
  setHandler(documentReviewState, () => state);
  setHandler(approveDocument, () => {
    // 提前、重复或已进入清理阶段的 Signal 不改变审核结果。
    if (state.status !== 'waiting_review' || state.approvedAt) return;
    state.approvedAt = new Date().toISOString();
  });

  const invalid = documentInputError(input);
  if (invalid) {
    state.status = 'failed';
    state.error = invalid;
    throw ApplicationFailure.nonRetryable(invalid, 'InvalidDocumentReviewInput');
  }
  const args = { workflowId, documentId: input.documentId, losePrepareResponse: input.losePrepareResponse };
  try {
    // 必须在 await 前记录“已经尝试”；失败/取消并不能证明 SQLite 没有写入。
    state.prepareAttempted = true;
    await prepareDocument(args);
    state.prepareCompleted = true;
    state.status = 'waiting_review';
    // 沙箱的 Date/condition 由 Temporal 历史驱动，重放时不会重新计算现实世界时间。
    state.reviewDeadline = new Date(Date.now() + input.reviewTimeoutSeconds * 1_000).toISOString();
    if (!await condition(() => state.approvedAt !== undefined, input.reviewTimeoutSeconds * 1_000)) {
      throw ApplicationFailure.nonRetryable('资料审核等待超时', 'DocumentReviewTimedOut');
    }
    state.status = 'archiving';
    await archiveDocument(args);
    state.status = 'completed';
    return state;
  } catch (error) {
    const cancelled = isCancellation(error);
    const timedOut = error instanceof ApplicationFailure && error.type === 'DocumentReviewTimedOut';
    state.error = failureDetail(error);
    if (state.prepareAttempted) {
      state.status = 'cleaning_up';
      state.cleanup.status = 'running';
      try {
        await CancellationScope.nonCancellable(async () => {
          const result = await cleanupDocument(args);
          state.cleanup = { status: 'completed', outcome: result.outcome };
        });
      } catch (cleanupError) {
        state.status = 'failed';
        state.cleanup = {
          status: 'failed',
          error: failureDetail(cleanupError),
        };
        throw ApplicationFailure.nonRetryable(
          `资料清理未完成：${state.cleanup.error}；原始原因：${state.error}`,
          'DocumentCleanupFailed',
        );
      }
    }
    state.status = cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed';
    if (cancelled) throw new CancelledFailure('资料审核协作取消；已完成清理查账');
    if (timedOut) throw error;
    throw ApplicationFailure.nonRetryable(`资料审核失败：${state.error}`, 'DocumentReviewFailed');
  }
}
