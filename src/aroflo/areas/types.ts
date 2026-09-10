import type { Area } from '../../config.js';
import type { EncodedPair } from '../query.js';

export type FilterOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith';
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime';
export type FilterValue = string | number | boolean;

export interface FieldDefinition {
  apiName: string;
  type: FieldType;
  sensitive?: boolean;
  requiredOnCreate?: boolean;
  mutable?: boolean;
}

export interface AreaDefinition {
  area: Area;
  zone: string;
  identifier: string;
  fields: Readonly<Record<string, FieldDefinition>>;
  filters: Readonly<Record<string, readonly FilterOperator[]>>;
  joins: readonly string[];
  orderFields: readonly string[];
  createFields: readonly string[];
  updateFields: readonly string[];
}

export interface FilterInput {
  field: string;
  operator: FilterOperator;
  value: FilterValue;
}

export interface SearchInput {
  area: Area;
  filters?: readonly FilterInput[];
  joins?: readonly string[];
  order?: { readonly field: string; readonly direction: 'asc' | 'desc' };
  page?: number;
  pageSize?: number;
}

export type ReadQuery = readonly EncodedPair[];

export type FieldInput = FieldType | readonly [FieldType, Omit<FieldDefinition, 'apiName' | 'type'>];

export function publicFields(definitions: Readonly<Record<string, FieldInput>>): Readonly<Record<string, FieldDefinition>> {
  const fields = Object.create(null) as Record<string, FieldDefinition>;
  for (const [apiName, input] of Object.entries(definitions)) {
    const [type, metadata] = typeof input === 'string' ? [input, {}] : input;
    fields[apiName] = Object.freeze({ apiName, type, ...metadata });
  }
  return Object.freeze(fields);
}

export function filterFields(
  names: readonly string[],
  operators: readonly FilterOperator[] = ['eq', 'ne', 'lt', 'gt', 'contains']
): Readonly<Record<string, readonly FilterOperator[]>> {
  const filters = Object.create(null) as Record<string, readonly FilterOperator[]>;
  for (const name of names) filters[name] = Object.freeze([...operators]);
  return Object.freeze(filters);
}

export function defineArea<const T extends AreaDefinition>(definition: T): Readonly<T> {
  const filters = Object.create(null) as Record<string, readonly FilterOperator[]>;
  for (const [name, operators] of Object.entries(definition.filters)) filters[name] = Object.freeze([...operators]);
  return Object.freeze({
    ...definition,
    filters: Object.freeze(filters),
    joins: Object.freeze([...definition.joins]),
    orderFields: Object.freeze([...definition.orderFields]),
    createFields: Object.freeze([...definition.createFields]),
    updateFields: Object.freeze([...definition.updateFields])
  }) as Readonly<T>;
}
