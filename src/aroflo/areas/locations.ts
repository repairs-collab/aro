import { publicFields, type AreaDefinition } from './types.js';

export const locations = { area: 'locations', zone: 'locations', identifier: 'locationid', fields: publicFields(['locationid', 'createdutc']), filters: { createdutc: ['gt'] }, joins: [], createFields: [], updateFields: [] } as const satisfies AreaDefinition;
