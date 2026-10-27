import { ApplicationFailure, defineQuery, defineSignal, setHandler, workflowInfo } from '@temporalio/workflow';
import {
  APPROVE_DOCUMENT_SIGNAL,
  DOCUMENT_REVIEW_STATE_QUERY,
  type DocumentReviewInput,
  type DocumentReviewState,
} from '../support/types';

const approveDocument = defineSignal(APPROVE_DOCUMENT_SIGNAL);
const documentReviewState = defineQuery<DocumentReviewState>(DOCUMENT_REVIEW_STATE_QUERY);

export async function documentReviewWorkflow(input: DocumentReviewInput): Promise<DocumentReviewState> {
  const { workflowId, runId } = workflowInfo();
  const state: DocumentReviewState = {
    workflowId,
    runId,
    documentId: input.documentId,
    status: 'not_implemented',
    prepareAttempted: false,
    prepareCompleted: false,
    cleanup: { status: 'idle' },
  };
  setHandler(documentReviewState, () => state);
  setHandler(approveDocument, () => {
    // TODO：仅 waiting_review 时接受首次 Signal，记录 approvedAt；明确提前/重复 Signal 的策略。
  });

  // TODO 1：校验 DocumentReviewInput，使用 nonretryable failure 拒绝非法输入。
  // TODO 2：proxyActivities<DocumentReviewActivities>；最多两次尝试，稳定幂等键来自 workflowId。
  //         配置心跳、超时和 WAIT_CANCELLATION_COMPLETED，防止清理与仍在运行的准备操作竞态。
  // TODO 3：在 await prepareDocument 之前标记 prepareAttempted，成功后标记 prepareCompleted。
  // TODO 4：进入 waiting_review，记录确定性的 reviewDeadline，用 condition 等 Signal 或超时。
  // TODO 5：审核通过后调用 archiveDocument，完成时返回 DocumentReviewState。
  // TODO 6：任意失败/超时/协作取消都在 nonCancellable 中调用 cleanupDocument 查账。
  //         不能只检查 prepareCompleted；清理失败必须显示失败，不能伪装已清理。
  // TODO 7：完成清理后抛 nonretryable failure 或 CancelledFailure；业务 cancelled 不是执行终态。
  // 删除下方占位失败前，请先实现以上分支；不要临时 return completed。
  throw ApplicationFailure.nonRetryable('请先完成 problem/workflow.ts 中的 TODO', 'DocumentReviewNotImplemented');
}
