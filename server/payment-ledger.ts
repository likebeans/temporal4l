import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PaymentEntry, PaymentLedger } from '../shared/types';

export class PaymentStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS payments (
        workflow_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        amount REAL NOT NULL,
        refunded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS payment_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        amount REAL NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payment_entries_workflow ON payment_entries(workflow_id);
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

  private append(workflowId: string, kind: PaymentEntry['kind'], attempt: number, amount: number, message: string): void {
    this.db.prepare(`
      INSERT INTO payment_entries (workflow_id, kind, attempt, amount, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workflowId, kind, attempt, amount, message, new Date().toISOString());
  }

  recordAttempt(workflowId: string, attempt: number): void {
    this.append(workflowId, 'attempt', attempt, 0, `chargePayment 第 ${attempt} 次调用`);
  }

  recordFailure(workflowId: string, attempt: number, message: string): void {
    this.append(workflowId, 'failure', attempt, 0, message);
  }

  charge(workflowId: string, amount: number, attempt: number): { reused: boolean } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT amount FROM payments WHERE workflow_id = ?').get(workflowId);
      if (existing) {
        if (Number(existing.amount) !== amount) throw new Error('同一幂等键不能用于不同扣款金额');
        this.append(workflowId, 'reused', attempt, 0, '命中幂等键，复用已入账的付款结果');
        return { reused: true };
      }
      this.db.prepare('INSERT INTO payments (workflow_id, idempotency_key, amount) VALUES (?, ?, ?)')
        .run(workflowId, `${workflowId}:charge`, amount);
      this.append(workflowId, 'debit', attempt, amount, '模拟账本扣款入账');
      return { reused: false };
    });
  }

  refund(workflowId: string, attempt: number): void {
    this.transaction(() => {
      const payment = this.db.prepare('SELECT amount, refunded FROM payments WHERE workflow_id = ?').get(workflowId);
      if (!payment || Number(payment.refunded) === 1) return;
      this.db.prepare('UPDATE payments SET refunded = 1 WHERE workflow_id = ?').run(workflowId);
      this.append(workflowId, 'refund', attempt, Number(payment.amount), '模拟账本退款入账');
    });
  }

  get(workflowId: string): PaymentLedger {
    const rows = this.db.prepare(`
      SELECT id, kind, attempt, amount, message, created_at
      FROM payment_entries WHERE workflow_id = ? ORDER BY id
    `).all(workflowId);
    const entries = rows.map((row): PaymentEntry => ({
      id: Number(row.id),
      kind: row.kind as PaymentEntry['kind'],
      attempt: Number(row.attempt),
      amount: Number(row.amount),
      message: String(row.message),
      createdAt: String(row.created_at),
    }));
    const debits = entries.filter((entry) => entry.kind === 'debit');
    const refunds = entries.filter((entry) => entry.kind === 'refund');
    return {
      idempotencyKey: `${workflowId}:charge`,
      attempts: entries.filter((entry) => entry.kind === 'attempt').length,
      debitCount: debits.length,
      refundCount: refunds.length,
      totalCharged: debits.reduce((sum, entry) => sum + entry.amount, 0),
      totalRefunded: refunds.reduce((sum, entry) => sum + entry.amount, 0),
      entries,
    };
  }

  close(): void {
    this.db.close();
  }
}

let store: PaymentStore | undefined;

export function getPaymentStore(): PaymentStore {
  store ??= new PaymentStore(
    process.env.PAYMENT_DB_PATH || fileURLToPath(new URL('../.data/payments.db', import.meta.url)),
  );
  return store;
}

export function closePaymentStore(): void {
  store?.close();
  store = undefined;
}
