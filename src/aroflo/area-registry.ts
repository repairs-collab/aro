import { AREAS, type Area } from '../config.js';
import { assets } from './areas/assets.js';
import { clients } from './areas/clients.js';
import { invoices } from './areas/invoices.js';
import { inventory } from './areas/inventory.js';
import { locations } from './areas/locations.js';
import { quotes } from './areas/quotes.js';
import { schedules } from './areas/schedules.js';
import { tasks } from './areas/tasks.js';
import type { AreaDefinition, FilterOperator, SearchInput } from './areas/types.js';
import { users } from './areas/users.js';
import type { EncodedPair } from './query.js';

export const AREA_DEFINITIONS = new Map<Area, AreaDefinition>([
  [tasks.area, tasks],
  [clients.area, clients],
  [locations.area, locations],
  [quotes.area, quotes],
  [invoices.area, invoices],
  [schedules.area, schedules],
  [users.area, users],
  [assets.area, assets],
  [inventory.area, inventory]
]);

const wireOperators: Readonly<Record<FilterOperator, string>> = {
  eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=', contains: 'IN', startsWith: 'LIKE'
};

function invalidSearchInput(): Error {
  return new Error('Invalid AroFlo search input');
}

export function getAreaDefinition(area: Area): AreaDefinition {
  const definition = AREA_DEFINITIONS.get(area);
  if (definition === undefined) throw invalidSearchInput();
  return definition;
}

export function describeArea(area: Area): Omit<AreaDefinition, 'fields'> & { fields: readonly string[] } {
  const { fields, ...definition } = getAreaDefinition(area);
  return { ...definition, fields: Object.keys(fields) };
}

export function compileReadQuery(input: SearchInput): readonly EncodedPair[] {
  const definition = getAreaDefinition(input.area);
  const filters = input.filters ?? [];
  const joins = input.joins ?? [];
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 100;

  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw invalidSearchInput();
  }
  if (filters.length > 10 || joins.length > 5) throw invalidSearchInput();

  const pairs: EncodedPair[] = [['zone', definition.zone]];
  for (const filter of filters) {
    const allowedOperators = definition.filters[filter.field];
    if (
      allowedOperators === undefined ||
      !allowedOperators.includes(filter.operator) ||
      (typeof filter.value === 'string' && filter.value.includes('|'))
    ) {
      throw invalidSearchInput();
    }
    pairs.push(['where', `and|${filter.field}|${wireOperators[filter.operator]}|${filter.value}`]);
  }
  for (const join of joins) {
    if (!definition.joins.includes(join)) throw invalidSearchInput();
    pairs.push(['join', join]);
  }
  if (input.order !== undefined) {
    if (definition.fields[input.order.field] === undefined || !['asc', 'desc'].includes(input.order.direction)) {
      throw invalidSearchInput();
    }
    pairs.push(['order', `${input.order.field}|${input.order.direction}`]);
  }
  pairs.push(['page', page], ['pageSize', pageSize]);
  return Object.freeze(pairs);
}

export function isFinancialArea(area: Area): boolean {
  return area === 'invoices';
}

export const areaNames = AREAS;
