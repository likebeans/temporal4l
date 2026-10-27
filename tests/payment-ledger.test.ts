import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PaymentStore } from '../server/payment-ledger';

test('PaymentStore persists idempotent charges and refunds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-payment-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await t.test('reuses a repeated charge key without a second debit', () => {
    const store = new PaymentStore(join(directory, 'repeat.db'));
    try {
      assert.deepEqual(store.charge('order-repeat', 299, 1), { reused: false });
      assert.deepEqual(store.charge('order-repeat', 299, 2), { reused: true });

      const ledger = store.get('order-repeat');
      assert.equal(ledger.idempotencyKey, 'order-repeat:charge');
      assert.equal(ledger.debitCount, 1);
      assert.equal(ledger.totalCharged, 299);
      assert.deepEqual(ledger.entries.map((entry) => entry.kind), ['debit', 'reused']);
    } finally {
      store.close();
    }
  });

  await t.test('retains a charge after closing and reopening the database', () => {
    const filename = join(directory, 'reopen.db');
    const original = new PaymentStore(filename);
    original.recordAttempt('order-reopen', 1);
    original.charge('order-reopen', 499, 1);
    original.close();

    const reopened = new PaymentStore(filename);
    try {
      const ledger = reopened.get('order-reopen');
      assert.equal(ledger.attempts, 1);
      assert.equal(ledger.debitCount, 1);
      assert.equal(ledger.totalCharged, 499);
    } finally {
      reopened.close();
    }
  });

  await t.test('rejects reuse of a charge key with a different amount', () => {
    const store = new PaymentStore(join(directory, 'mismatch.db'));
    try {
      store.charge('order-mismatch', 299, 1);
      assert.throws(
        () => store.charge('order-mismatch', 499, 2),
        /同一幂等键不能用于不同扣款金额/,
      );

      const ledger = store.get('order-mismatch');
      assert.equal(ledger.debitCount, 1);
      assert.equal(ledger.totalCharged, 299);
      assert.deepEqual(ledger.entries.map((entry) => entry.kind), ['debit']);
    } finally {
      store.close();
    }
  });

  await t.test('records at most one refund for repeated requests', () => {
    const store = new PaymentStore(join(directory, 'refund.db'));
    try {
      store.charge('order-refund', 178, 1);
      store.refund('order-refund', 1);
      store.refund('order-refund', 2);

      const ledger = store.get('order-refund');
      assert.equal(ledger.refundCount, 1);
      assert.equal(ledger.totalRefunded, 178);
      assert.deepEqual(ledger.entries.map((entry) => entry.kind), ['debit', 'refund']);
    } finally {
      store.close();
    }
  });
});
