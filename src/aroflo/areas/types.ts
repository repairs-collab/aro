import type { Area } from '../../config.js';
import type { EncodedPair } from '../query.js';

export type FilterOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith';
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime';
export type MutationFormat = 'YYYY/MM/DD' | 'YYYY/MM/DD HH:mm:ss';
export type FilterValue = string | number | boolean;

export interface FieldDefinition {
  apiName: string;
  type: FieldType;
  sensitive?: boolean;
  requiredOnCreate?: boolean;
  mutable?: boolean;
  mutationFormat?: MutationFormat;
}

export interface MutationEnvelope {
  root: string;
  record: string;
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
  mutationEnvelope: MutationEnvelope | null;
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
  fresh?: boolean;
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
  operators: readonly FilterOperator[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains']
): Readonly<Record<string, readonly FilterOperator[]>> {
  const filters = Object.create(null) as Record<string, readonly FilterOperator[]>;
  for (const name of names) filters[name] = Object.freeze([...operators]);
  return Object.freeze(filters);
}

export function defineArea<const T extends AreaDefinition>(definition: T): Readonly<T> {
  const invalidDefinition = (): never => {
    throw new Error('Invalid AroFlo area definition');
  };
  const hasWrites = definition.createFields.length > 0 || definition.updateFields.length > 0;
  if (
    !Object.hasOwn(definition.fields, definition.identifier) ||
    (hasWrites && definition.mutationEnvelope === null) ||
    (!hasWrites && definition.mutationEnvelope !== null) ||
    (definition.mutationEnvelope !== null && (
      !isValidXmlElementName(definition.mutationEnvelope.root) ||
      !isValidXmlElementName(definition.mutationEnvelope.record)
    ))
  ) {
    invalidDefinition();
  }

  const mutationFieldNames = [...new Set([...definition.createFields, ...definition.updateFields, definition.identifier])];
  const mutationPaths: string[] = [];
  for (const fieldName of mutationFieldNames) {
    if (!Object.hasOwn(definition.fields, fieldName)) invalidDefinition();
    const field = definition.fields[fieldName] ?? invalidDefinition();
    if (!isValidMutationPath(field.apiName)) invalidDefinition();
    if (
      (field.type === 'date' && field.mutationFormat !== 'YYYY/MM/DD') ||
      (field.type === 'datetime' && field.mutationFormat !== 'YYYY/MM/DD HH:mm:ss')
    ) {
      invalidDefinition();
    }
    mutationPaths.push(field.apiName);
  }
  for (let index = 0; index < mutationPaths.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < mutationPaths.length; otherIndex += 1) {
      const path = mutationPaths[index];
      const otherPath = mutationPaths[otherIndex];
      if (
        path === undefined || otherPath === undefined ||
        path === otherPath || path.startsWith(`${otherPath}.`) || otherPath.startsWith(`${path}.`)
      ) {
        invalidDefinition();
      }
    }
  }

  const fields = Object.create(null) as Record<string, FieldDefinition>;
  for (const [name, field] of Object.entries(definition.fields)) fields[name] = Object.freeze({ ...field });
  const filters = Object.create(null) as Record<string, readonly FilterOperator[]>;
  for (const [name, operators] of Object.entries(definition.filters)) filters[name] = Object.freeze([...operators]);
  return Object.freeze({
    ...definition,
    fields: Object.freeze(fields),
    filters: Object.freeze(filters),
    joins: Object.freeze([...definition.joins]),
    orderFields: Object.freeze([...definition.orderFields]),
    createFields: Object.freeze([...definition.createFields]),
    updateFields: Object.freeze([...definition.updateFields]),
    mutationEnvelope: definition.mutationEnvelope === null
      ? null
      : Object.freeze({ ...definition.mutationEnvelope })
  }) as Readonly<T>;
}

function isValidMutationPath(path: unknown): boolean {
  return typeof path === 'string' && path.split('.').every(isValidXmlElementName);
}

function isValidXmlElementName(name: unknown): boolean {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}
