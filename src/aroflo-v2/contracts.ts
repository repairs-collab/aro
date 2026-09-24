export const INVOICE_TYPES = ['FINAL_INVOICE', 'PART_INVOICE'] as const;

export const INVOICE_LAYOUTS = [
  'SIMPLE',
  'LAB_AND_MAT_ITEMS',
  'DETAILED',
  'LAB_AND_MAT_SIMPLE',
  'ITEMISED',
  'ITEMISED_MAT',
  'ITEMISED_QTY',
  'SIMPLE_IMP',
  'SIMPLE_MAT_AND_EXP'
] as const;

export interface InvoiceListQuery {
  zoneName?: 'TASKS' | 'QUOTES' | 'WORK_ORDERS';
  businessUnitId: string;
  taskId?: string;
  workOrderId?: string;
  status?: 0 | 1 | 2 | 3;
  allStatus?: 0 | 1;
  clientId?: string;
  paymentStatus?: 0 | 1 | 2;
  type?: 'task';
  userBuAccessType?: 'childbus' | 'thisbu' | 'allbus';
  sortBy?: 'invoiceNo' | 'invoicedDate' | 'dueDate' | 'clientName';
  orderBy?: 'asc' | 'desc';
  allowSubInv?: 0 | 1;
  page?: number;
  limit?: number;
  fields?: readonly string[];
}

export interface InvoiceLineListQuery {
  page?: number;
  limit?: number;
  fields?: readonly string[];
}

export interface CreateInvoiceInput {
  businessUnitId: string;
  taskId: string;
  type: (typeof INVOICE_TYPES)[number];
  defaultLayout?: (typeof INVOICE_LAYOUTS)[number];
  expenseTrackingCenterId?: string;
  labourTrackingCenterId?: string;
  materialTrackingCenterId?: string;
  overrideQuote?: boolean;
  taxInclusive?: boolean;
}

export interface InvoiceLinePatch {
  accountCode?: string;
  costEx?: number;
  description?: string;
  discount?: number;
  id?: string;
  listOrder?: number;
  markup?: number;
  partNumber?: string;
  quantity?: number;
  sell?: number;
  taxCode?: string;
  totalEx?: number;
  trackingCentre?: string;
}

type V2Query = InvoiceListQuery | InvoiceLineListQuery | { fields?: readonly string[] };

const QUERY_PROPERTIES = [
  'zoneName',
  'businessUnitId',
  'taskId',
  'workOrderId',
  'status',
  'allStatus',
  'clientId',
  'paymentStatus',
  'type',
  'userBuAccessType',
  'sortBy',
  'orderBy',
  'allowSubInv',
  'page',
  'limit'
] as const;

export function encodeV2Query(query: V2Query): URLSearchParams {
  const params = new URLSearchParams();
  const values = query as Record<string, unknown>;

  for (const property of QUERY_PROPERTIES) {
    const value = values[property];
    if (typeof value === 'string' || typeof value === 'number') params.append(property, String(value));
  }

  if (Array.isArray(query.fields) && query.fields.length > 0) {
    params.append('_fields', query.fields.join(','));
  }

  return params;
}
