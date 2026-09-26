import * as z from 'zod/v4';
import { INVOICE_LAYOUTS, INVOICE_TYPES } from '../aroflo-v2/contracts.js';

const boundedId = z.string().trim().min(1).max(256);
const boundedShortText = z.string().max(1_000);
const finiteNumber = z.number().finite();
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

export const createInvoiceSchema = z.strictObject({
  businessUnitId: boundedId,
  taskId: boundedId,
  type: z.enum(INVOICE_TYPES),
  defaultLayout: z.enum(INVOICE_LAYOUTS).optional(),
  expenseTrackingCenterId: boundedId.optional(),
  labourTrackingCenterId: boundedId.optional(),
  materialTrackingCenterId: boundedId.optional(),
  overrideQuote: z.boolean().optional(),
  taxInclusive: z.boolean().optional()
});

export const invoiceLinePatchSchema = z.strictObject({
  accountCode: boundedShortText.optional(),
  costEx: finiteNumber.optional(),
  description: z.string().max(10_000).optional(),
  discount: finiteNumber.optional(),
  id: boundedId.optional(),
  listOrder: z.number().int().min(0).optional(),
  markup: finiteNumber.optional(),
  partNumber: boundedShortText.optional(),
  quantity: finiteNumber.optional(),
  sell: finiteNumber.optional(),
  taxCode: boundedShortText.optional(),
  totalEx: finiteNumber.optional(),
  trackingCentre: boundedShortText.optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one line field is required');

export const previewInvoiceLineUpdateSchema = z.strictObject({
  invoiceId: boundedId,
  invoiceLineItemId: boundedId,
  fields: invoiceLinePatchSchema
}).refine(
  (value) => value.fields.id === undefined || value.fields.id === value.invoiceLineItemId,
  { message: 'Line item body id must match invoiceLineItemId', path: ['fields', 'id'] }
);

export const executeV2WriteSchema = z.strictObject({
  confirmationId: z.string().min(20).max(200)
});

export type InvoiceListInput = z.infer<typeof invoiceListSchema>;
export type InvoiceGetInput = z.infer<typeof invoiceGetSchema>;
export type InvoiceRecipientsInput = z.infer<typeof invoiceRecipientsSchema>;
export type InvoiceLineListInput = z.infer<typeof invoiceLineListSchema>;
export type CreateInvoiceToolInput = z.infer<typeof createInvoiceSchema>;
export type InvoiceLinePatchInput = z.infer<typeof invoiceLinePatchSchema>;
export type PreviewInvoiceLineUpdateInput = z.infer<typeof previewInvoiceLineUpdateSchema>;
export type ExecuteV2WriteInput = z.infer<typeof executeV2WriteSchema>;
