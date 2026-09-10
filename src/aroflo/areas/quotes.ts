import { publicFields, type AreaDefinition } from './types.js';

export const quotes = { area: 'quotes', zone: 'quotes', identifier: 'quoteid', fields: publicFields(['quoteid']), filters: { quoteid: ['eq'] }, joins: ['documentsandphotos', 'lineitems', 'notes', 'projects', 'trackingcentres'], createFields: [], updateFields: [] } as const satisfies AreaDefinition;
