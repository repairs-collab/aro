import { randomBytes } from 'node:crypto';
import type { CreateInvoiceInput, InvoiceLinePatch } from './contracts.js';

export type V2InvoiceOperation =
  | { kind: 'createInvoice'; input: CreateInvoiceInput }
  | {
      kind: 'updateInvoiceLineItem';
      invoiceId: string;
      invoiceLineItemId: string;
      fields: InvoiceLinePatch;
    };

export interface V2ConfirmationStoreOptions {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
  maxPending?: number;
}

interface ConfirmationEntry {
  expiresAtMs: number;
  operation: V2InvoiceOperation;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_PENDING = 100;

export class V2ConfirmationStore {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly entries = new Map<string, ConfirmationEntry>();

  constructor(options: V2ConfirmationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => randomBytes(24).toString('base64url'));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  issue(operation: V2InvoiceOperation): { confirmationId: string; expiresAt: string } {
    const nowMs = this.now();
    this.removeExpired(nowMs);

    while (this.entries.size >= this.maxPending) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) break;
      this.entries.delete(oldestId);
    }

    const confirmationId = this.createId();
    const expiresAtMs = nowMs + this.ttlMs;
    const storedOperation = deepFreeze(structuredClone(operation)) as V2InvoiceOperation;
    this.entries.set(confirmationId, { expiresAtMs, operation: storedOperation });

    return { confirmationId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(confirmationId: string): V2InvoiceOperation {
    const entry = this.entries.get(confirmationId);
    if (entry === undefined) throw new Error('Confirmation is invalid or expired');

    this.entries.delete(confirmationId);
    if (entry.expiresAtMs <= this.now()) throw new Error('Confirmation is invalid or expired');

    return entry.operation;
  }

  private removeExpired(nowMs: number): void {
    for (const [confirmationId, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(confirmationId);
    }
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;

  seen.add(value);
  for (const property of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, property), seen);
  }

  return Object.freeze(value);
}
