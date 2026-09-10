import { publicFields, type AreaDefinition } from './types.js';

export const assets = { area: 'assets', zone: 'assets', identifier: 'assetid', fields: publicFields(['assetid', 'category', 'assetname', 'modelnumber', 'manufacturer', 'category.categoryid', 'datecreated', 'location.locationid']), filters: { category: ['eq'] }, joins: ['location', 'customfields', 'notes', 'documentsandphotos'], createFields: ['assetname', 'modelnumber', 'manufacturer', 'category.categoryid', 'datecreated'], updateFields: ['assetid', 'location.locationid'] } as const satisfies AreaDefinition;
