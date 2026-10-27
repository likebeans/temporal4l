import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  DocumentActivityArgs,
  DocumentActivityExecution,
  DocumentEntry,
  DocumentEntryKind,
  DocumentLedger,
  DocumentReviewActivities,
} from './types';

export function documentDatabasePath(): string {
  return process.env.DOCUMENT_REVIEW_DB_PATH
    || fileURLToPath(new URL('../../../../.data/document-review.db', import.meta.url));
}

export class DocumentStoreConflict extends Error {}

export class DocumentReviewStore {
  private readonly db: DatabaseSync;

  constructor(filename: string, readOnly = false) {
    if (!readOnly && filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { readOnly });
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (readOnly) return;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS document_reviews (
        workflow_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'archived', 'removed')),
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS document_review_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_review_entries_workflow
        ON document_review_entries(workflow_id);
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private append(
    workflowId: string,
    execution: DocumentActivityExecution,
    kind: DocumentEntryKind,
    message: string,
  ): void {
    this.db.prepare(`
      INSERT INTO document_review_entries
        (workflow_id, run_id, activity_id, kind, attempt, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workflowId, execution.runId, execution.activityId, kind, execution.attempt, message, new Date().toISOString());
  }

  prepare(args: DocumentActivityArgs, execution: DocumentActivityExecution): {
    idempotencyKey: string;
    reused: boolean;
    loseResponse: boolean;
  } {
    return this.transaction(() => {
      const { workflowId, documentId } = args;
      const idempotencyKey = `${workflowId}:prepare`;
      this.append(workflowId, execution, 'prepare_attempt', '调用 prepareDocument；attempt 仅用于审计');
      const existing = this.db.prepare('SELECT document_id, status FROM document_reviews WHERE workflow_id = ?')
        .get(workflowId);
      if (existing && (existing.document_id !== documentId || existing.status === 'removed')) {
        throw new DocumentStoreConflict('同一 Workflow ID 不得用于另一份资料或重新创建已清理资料');
      }
      if (existing) {
        this.append(workflowId, execution, 'reused', '复用同一幂等键已提交的资料');
      } else {
        this.db.prepare(`
          INSERT INTO document_reviews (workflow_id, idempotency_key, document_id, status, content)
          VALUES (?, ?, ?, 'prepared', ?)
        `).run(workflowId, idempotencyKey, documentId, `仅供本地练习的资料：${documentId}`);
        this.append(workflowId, execution, 'prepared', '本地资料内容与 prepared 审计在同一事务提交');
      }
      // 故障标记也随业务写入持久化；Worker 重启不会再次丢弃响应。
      const loseResponse = args.losePrepareResponse === true && !existing;
      if (loseResponse) this.append(workflowId, execution, 'response_lost', '提交后将模拟首次响应丢失');
      return { idempotencyKey, reused: Boolean(existing), loseResponse };
    });
  }

  archive(args: DocumentActivityArgs, execution: DocumentActivityExecution): void {
    this.transaction(() => {
      this.append(args.workflowId, execution, 'archive_attempt', '调用 archiveDocument');
      const existing = this.db.prepare('SELECT document_id, status FROM document_reviews WHERE workflow_id = ?')
        .get(args.workflowId);
      if (!existing || existing.document_id !== args.documentId || existing.status === 'removed') {
        throw new DocumentStoreConflict('归档需要同一 Workflow ID 下尚未清理的资料');
      }
      if (existing.status === 'archived') {
        this.append(args.workflowId, execution, 'archive_reused', '资料已经归档，复用结果');
        return;
      }
      this.db.prepare("UPDATE document_reviews SET status = 'archived' WHERE workflow_id = ?").run(args.workflowId);
      this.append(args.workflowId, execution, 'archived', '本地归档状态与审计在同一事务提交');
    });
  }

  cleanup(args: DocumentActivityArgs, execution: DocumentActivityExecution): Awaited<ReturnType<DocumentReviewActivities['cleanupDocument']>> {
    return this.transaction(() => {
      this.append(args.workflowId, execution, 'cleanup_attempt', '按 Workflow ID 查账，不依赖 Workflow 是否收到准备结果');
      const existing = this.db.prepare('SELECT document_id, status FROM document_reviews WHERE workflow_id = ?')
        .get(args.workflowId);
      if (!existing) {
        this.append(args.workflowId, execution, 'cleanup_absent', '查账确认没有已提交资料');
        return { outcome: 'absent' };
      }
      if (existing.document_id !== args.documentId) throw new DocumentStoreConflict('清理资料与原幂等键不匹配');
      if (existing.status === 'removed') {
        this.append(args.workflowId, execution, 'cleanup_reused', '资料已经清理，保留幂等墓碑');
        return { outcome: 'already_removed' };
      }
      this.db.prepare("UPDATE document_reviews SET status = 'removed', content = NULL WHERE workflow_id = ?")
        .run(args.workflowId);
      this.append(args.workflowId, execution, 'removed', '删除本地内容，保留资料 ID、幂等键及审计');
      return { outcome: 'removed' };
    });
  }

  get(workflowId: string): DocumentLedger {
    // 两次读取也在同一 SQLite 事务内；这不使它与 Temporal 成为原子快照。
    this.db.exec('BEGIN');
    try {
      const row = this.db.prepare('SELECT document_id, status, content FROM document_reviews WHERE workflow_id = ?')
        .get(workflowId);
      const entries = this.db.prepare(`
        SELECT id, run_id, activity_id, kind, attempt, message, created_at
        FROM document_review_entries WHERE workflow_id = ? ORDER BY id
      `).all(workflowId).map((entry): DocumentEntry => ({
        id: Number(entry.id),
        runId: String(entry.run_id),
        activityId: String(entry.activity_id),
        kind: entry.kind as DocumentEntryKind,
        attempt: Number(entry.attempt),
        message: String(entry.message),
        createdAt: String(entry.created_at),
      }));
      const count = (kind: DocumentEntryKind): number => entries.filter((entry) => entry.kind === kind).length;
      const ledger: DocumentLedger = {
        workflowId,
        idempotencyKey: `${workflowId}:prepare`,
        document: row ? {
          documentId: String(row.document_id),
          status: row.status as NonNullable<DocumentLedger['document']>['status'],
          content: row.content === null ? null : String(row.content),
        } : null,
        prepareAttempts: count('prepare_attempt'),
        prepared: count('prepared'),
        reused: count('reused'),
        archived: count('archived'),
        removed: count('removed'),
        entries,
      };
      this.db.exec('COMMIT');
      return ledger;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
