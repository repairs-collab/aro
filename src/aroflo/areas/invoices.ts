import { publicFields, type AreaDefinition } from './types.js';

export const invoices = { area: 'invoices', zone: 'invoices', identifier: 'invoiceid', fields: publicFields(['invoiceid', 'status', 'linkprocessed', 'taskid']), filters: { status: ['eq'], linkprocessed: ['eq'], taskid: ['eq'] }, joins: ['lineitems', 'trackingcentres', 'task', 'project'], createFields: [], updateFields: ['invoiceid', 'status'] } as const satisfies AreaDefinition;
