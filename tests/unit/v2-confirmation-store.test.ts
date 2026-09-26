import { describe, expect, it } from 'vitest';
import {
  V2ConfirmationStore,
  type V2InvoiceOperation
} from '../../src/aroflo-v2/confirmation-store.js';

const createInvoiceOperation = (): Extract<V2InvoiceOperation, { kind: 'createInvoice' }> => ({
  kind: 'createInvoice',
  input: {
    businessUnitId: 'bu-1',
    taskId: 'task-1',
    type: 'FINAL_INVOICE',
    defaultLayout: 'SIMPLE'
  }
});

describe('V2ConfirmationStore', () => {
  it('issues a confirmation with a ten-minute expiry and consumes its operation once', () => {
    let nowMs = Date.parse('2026-09-24T00:00:00.000Z');
    const store = new V2ConfirmationStore({
      now: () => nowMs,
      createId: () => 'confirmation-1'
    });

    expect(store.issue(createInvoiceOperation())).toEqual({
      confirmationId: 'confirmation-1',
      expiresAt: '2026-09-24T00:10:00.000Z'
    });
    expect(store.consume('confirmation-1')).toMatchObject({ kind: 'createInvoice' });
    expect(() => store.consume('confirmation-1')).toThrow(/invalid or expired/i);

    nowMs += 1;
  });

  it('rejects an expired confirmation', () => {
    let nowMs = Date.parse('2026-09-24T00:00:00.000Z');
    const store = new V2ConfirmationStore({
      now: () => nowMs,
      createId: () => 'confirmation-1'
    });
    store.issue(createInvoiceOperation());

    nowMs += 600_000;

    expect(() => store.consume('confirmation-1')).toThrow(/invalid or expired/i);
  });

  it('rejects an unknown confirmation ID', () => {
    const store = new V2ConfirmationStore({ createId: () => 'confirmation-1' });

    expect(() => store.consume('unknown')).toThrow(/invalid or expired/i);
  });

  it('does not retain confirmations when a new store starts', () => {
    const previousStore = new V2ConfirmationStore({ createId: () => 'confirmation-1' });
    const issued = previousStore.issue(createInvoiceOperation());
    const restartedStore = new V2ConfirmationStore({ createId: () => 'confirmation-1' });

    expect(() => restartedStore.consume(issued.confirmationId)).toThrow(/invalid or expired/i);
  });

  it('allows only one consume when two callers race', async () => {
    const store = new V2ConfirmationStore({ createId: () => 'confirmation-1' });
    store.issue(createInvoiceOperation());

    const results = await Promise.all(
      [0, 1].map(async () => {
        try {
          return store.consume('confirmation-1');
        } catch {
          return undefined;
        }
      })
    );

    expect(results.filter((result) => result?.kind === 'createInvoice')).toHaveLength(1);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
  });

  it('evicts the oldest pending confirmation when the maximum is reached', () => {
    let nextId = 0;
    const store = new V2ConfirmationStore({
      createId: () => `confirmation-${++nextId}`,
      maxPending: 2
    });

    store.issue(createInvoiceOperation());
    store.issue(createInvoiceOperation());
    store.issue(createInvoiceOperation());

    expect(() => store.consume('confirmation-1')).toThrow(/invalid or expired/i);
    expect(store.consume('confirmation-2')).toMatchObject({ kind: 'createInvoice' });
    expect(store.consume('confirmation-3')).toMatchObject({ kind: 'createInvoice' });
  });

  it('keeps exactly 100 pending confirmations by default', () => {
    let nextId = 0;
    const store = new V2ConfirmationStore({ createId: () => `confirmation-${++nextId}` });
    const confirmations = Array.from({ length: 101 }, () => store.issue(createInvoiceOperation()));

    expect(() => store.consume(confirmations[0]!.confirmationId)).toThrow(/invalid or expired/i);
    for (const confirmation of confirmations.slice(1)) {
      expect(store.consume(confirmation.confirmationId)).toMatchObject({ kind: 'createInvoice' });
    }
  });

  it('stores an immutable deep copy of the issued operation', () => {
    const store = new V2ConfirmationStore({ createId: () => 'confirmation-1' });
    const operation = createInvoiceOperation();

    store.issue(operation);
    operation.input.defaultLayout = 'ITEMISED';

    const consumed = store.consume('confirmation-1');

    if (consumed.kind !== 'createInvoice') throw new Error('Unexpected operation kind');

    expect(consumed).toMatchObject({
      kind: 'createInvoice',
      input: { defaultLayout: 'SIMPLE' }
    });
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed.input)).toBe(true);
    expect(() => {
      consumed.input.defaultLayout = 'ITEMISED';
    }).toThrow(TypeError);
  });
});
