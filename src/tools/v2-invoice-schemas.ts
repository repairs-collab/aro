import * as z from 'zod/v4';

const boundedId = z.string().trim().min(1).max(256);
const projectionField = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*\])?$/);
const projection = z.array(projectionField).min(1).max(50);

function validateInvoiceListCombination(
  value: {
    status?: 0 | 1 | 2 | 3 | undefined;
    allStatus?: 0 | 1 | undefined;
    taskId?: string | undefined;
    workOrderId?: string | undefined;
  },
  context: z.RefinementCtx
): void {
  if (value.status === undefined && value.allStatus !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'status is required unless allStatus is 1',
      path: ['status']
    });
  }
  if (value.taskId !== undefined && value.workOrderId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'taskId and workOrderId cannot be combined',
      path: ['workOrderId']
    });
  }
}

export const v2ConnectionStatusSchema = z.strictObject({});

export const invoiceListSchema = z.strictObject({
  zoneName: z.enum(['TASKS', 'QUOTES', 'WORK_ORDERS']).optional(),
  businessUnitId: boundedId,
  taskId: boundedId.optional(),
  workOrderId: boundedId.optional(),
  status: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  allStatus: z.union([z.literal(0), z.literal(1)]).optional(),
  clientId: boundedId.optional(),
  paymentStatus: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  type: z.literal('task').optional(),
  userBuAccessType: z.enum(['childbus', 'thisbu', 'allbus']).optional(),
  sortBy: z.enum(['invoiceNo', 'invoicedDate', 'dueDate', 'clientName']).optional(),
  orderBy: z.enum(['asc', 'desc']).optional(),
  allowSubInv: z.union([z.literal(0), z.literal(1)]).optional(),
  page: z.number().int().min(1).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  fields: projection.optional()
}).superRefine(validateInvoiceListCombination);

export const invoiceGetSchema = z.strictObject({
  invoiceId: boundedId,
  fields: projection.optional()
});

export const invoiceRecipientsSchema = z.strictObject({ invoiceId: boundedId });

export const invoiceLineListSchema = z.strictObject({
  invoiceId: boundedId,
  page: z.number().int().min(1).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  fields: projection.optional()
});

export type InvoiceListInput = z.infer<typeof invoiceListSchema>;
export type InvoiceGetInput = z.infer<typeof invoiceGetSchema>;
export type InvoiceRecipientsInput = z.infer<typeof invoiceRecipientsSchema>;
export type InvoiceLineListInput = z.infer<typeof invoiceLineListSchema>;
