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

export function publicFields(names: readonly string[]): Readonly<Record<string, FieldDefinition>> {
  return Object.freeze(
    Object.fromEntries(names.map((apiName) => [apiName, Object.freeze({ apiName, type: 'string' as const })]))
  );
}
