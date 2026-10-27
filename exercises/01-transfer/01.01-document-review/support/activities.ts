import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { DocumentReviewStore, DocumentStoreConflict } from './store';
import type { DocumentActivityExecution, DocumentReviewActivities } from './types';

export function createDocumentReviewActivities(store: DocumentReviewStore): DocumentReviewActivities {
  function execution(): DocumentActivityExecution {
    const context = Context.current();
    context.heartbeat();
    const workflowExecution = context.info.workflowExecution;
    if (!workflowExecution) throw new Error('练习活动必须由 Workflow 调用');
    return {
      runId: workflowExecution.runId,
      activityId: context.info.activityId,
      attempt: context.info.attempt,
    };
  }

  function apply<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof DocumentStoreConflict) {
        throw ApplicationFailure.nonRetryable(error.message, 'DocumentStoreConflict');
      }
      throw error;
    }
  }

  return {
    async prepareDocument(args) {
      const result = apply(() => store.prepare(args, execution()));
      // 事务已提交。故意不把结果返回 Workflow，让 SDK 按相同业务幂等键重试。
      if (result.loseResponse) {
        throw ApplicationFailure.retryable('本地资料已提交，但首次准备响应丢失', 'PrepareResponseLost');
      }
      return { idempotencyKey: result.idempotencyKey, reused: result.reused };
    },
    async archiveDocument(args) {
      apply(() => store.archive(args, execution()));
    },
    async cleanupDocument(args) {
      return apply(() => store.cleanup(args, execution()));
    },
  };
}
