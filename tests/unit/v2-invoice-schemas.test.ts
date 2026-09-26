import { describe, expect, it } from 'vitest';
import {
  invoiceGetSchema,
  invoiceLineListSchema,
  invoiceListSchema,
  invoiceRecipientsSchema,
  v2ConnectionStatusSchema
} from '../../src/tools/v2-invoice-schemas.js';

describe('AroFlo v2 invoice schemas', () => {
  it('accepts every documented invoice list enum and pagination boundary', () => {
    const cases = [
      ...(['TASKS', 'QUOTES', 'WORK_ORDERS'] as const).map((zoneName) => ({ zoneName })),
      ...([0, 1, 2, 3] as const).map((status) => ({ status })),
      ...([0, 1] as const).map((allStatus) => ({ allStatus })),
      ...([0, 1, 2] as const).map((paymentStatus) => ({ paymentStatus })),
      { type: 'task' as const },
      ...(['childbus', 'thisbu', 'allbus'] as const).map((userBuAccessType) => ({ userBuAccessType })),
      ...(['invoiceNo', 'invoicedDate', 'dueDate', 'clientName'] as const).map((sortBy) => ({ sortBy })),
      ...(['asc', 'desc'] as const).map((orderBy) => ({ orderBy })),
      ...([0, 1] as const).map((allowSubInv) => ({ allowSubInv })),
      { page: 1 },
      { page: 10 },
      { limit: 1 },
      { limit: 100 }
    ];

    for (const item of cases) {
      const input = 'allStatus' in item
        ? { businessUnitId: 'bu-1', ...(item.allStatus === 0 ? { status: 0 as const } : {}), ...item }
        : { businessUnitId: 'bu-1', allStatus: 1 as const, ...item };
      expect(invoiceListSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it('requires status unless allStatus is exactly one and rejects conflicting task selectors', () => {
    expect(invoiceListSchema.safeParse({
      businessUnitId: 'bu-1',
      allStatus: 1,
      page: 1,
      limit: 100
    }).success).toBe(true);
    expect(invoiceListSchema.safeParse({ businessUnitId: 'bu-1' }).success).toBe(false);
    expect(invoiceListSchema.safeParse({ businessUnitId: 'bu-1', allStatus: 0 }).success).toBe(false);
    expect(invoiceListSchema.safeParse({
      businessUnitId: 'bu-1',
      status: 1,
      taskId: 'task-1',
      workOrderId: 'wo-1'
    }).success).toBe(false);
  });

  it('accepts and trims bounded IDs across every ID-bearing schema', () => {
    const maxId = 'x'.repeat(256);
    for (const idField of ['businessUnitId', 'taskId', 'workOrderId', 'clientId'] as const) {
      const parsed = invoiceListSchema.parse({
        businessUnitId: 'bu-1',
        status: 0,
        [idField]: ` ${maxId} `
      });
      expect(parsed[idField]).toBe(maxId);
      for (const invalidId of ['', '   ', 'x'.repeat(257)]) {
        expect(invoiceListSchema.safeParse({
          businessUnitId: 'bu-1',
          status: 0,
          [idField]: invalidId
        }).success, `${idField}: ${JSON.stringify(invalidId)}`).toBe(false);
      }
    }
    expect(invoiceGetSchema.parse({ invoiceId: ' inv-1 ' })).toEqual({ invoiceId: 'inv-1' });
    expect(invoiceRecipientsSchema.parse({ invoiceId: maxId })).toEqual({ invoiceId: maxId });
    expect(invoiceLineListSchema.parse({ invoiceId: ' line-invoice ' })).toEqual({ invoiceId: 'line-invoice' });

    for (const invoiceId of ['', '   ', 'x'.repeat(257)]) {
      expect(invoiceGetSchema.safeParse({ invoiceId }).success, JSON.stringify(invoiceId)).toBe(false);
    }
  });

  it('accepts bounded field names and bracket projections', () => {
    expect(invoiceListSchema.safeParse({
      businessUnitId: 'bu-1',
      allStatus: 1,
      fields: ['id', 'client[id,name]', 'task[jobNumber,status]']
    }).success).toBe(true);
    expect(invoiceGetSchema.safeParse({ invoiceId: 'inv-1', fields: ['id', 'status'] }).success).toBe(true);
    expect(invoiceLineListSchema.safeParse({
      invoiceId: 'inv-1',
      fields: Array.from({ length: 50 }, (_, index) => `field${index}`)
    }).success).toBe(true);
  });

  it.each([
    [[]],
    [['client id']],
    [['client&id']],
    [['client=id']],
    [['client?id']],
    [['client#id']],
    [['client[id, name]']],
    [['client[]']],
    [['client[id']],
    [['x'.repeat(257)]],
    [Array.from({ length: 51 }, (_, index) => `field${index}`)]
  ])('rejects an unsafe or excessive projection: %j', (fields) => {
    expect(invoiceGetSchema.safeParse({ invoiceId: 'inv-1', fields }).success).toBe(false);
    expect(invoiceListSchema.safeParse({ businessUnitId: 'bu-1', allStatus: 1, fields }).success).toBe(false);
    expect(invoiceLineListSchema.safeParse({ invoiceId: 'inv-1', fields }).success).toBe(false);
  });

  it('rejects unknown properties and out-of-range list values', () => {
    expect(invoiceListSchema.safeParse({
      businessUnitId: 'bu-1',
      allStatus: 1,
      unexpected: true
    }).success).toBe(false);
    expect(v2ConnectionStatusSchema.safeParse({ rawUrl: 'https://example.test' }).success).toBe(false);
    expect(invoiceRecipientsSchema.safeParse({ invoiceId: 'inv-1', headers: {} }).success).toBe(false);

    for (const input of [
      { status: -1 }, { status: 4 }, { allStatus: 2 }, { paymentStatus: 3 },
      { type: 'quote' }, { userBuAccessType: 'parentbus' }, { sortBy: 'status' },
      { orderBy: 'sideways' }, { allowSubInv: 2 }, { page: 0 }, { page: 11 },
      { limit: 0 }, { limit: 101 }
    ]) {
      expect(invoiceListSchema.safeParse({ businessUnitId: 'bu-1', allStatus: 1, ...input }).success).toBe(false);
    }
  });
});
