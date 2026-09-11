import type { Area } from '../config.js';
import { AREA_DEFINITIONS } from './area-registry.js';
import type { AreaDefinition, FieldDefinition } from './areas/types.js';

export type ChangeOperation = 'create' | 'update';

export interface ChangeInput {
  area: Area;
  operation: ChangeOperation;
  id?: string;
  fields: Readonly<Record<string, unknown>>;
}

export interface ChangePreview {
  area: Area;
  operation: ChangeOperation;
  id?: string;
  changedFields: readonly string[];
  redactedValues: Readonly<Record<string, unknown>>;
  warnings: readonly string[];
}

export interface CompiledChange {
  zone: string;
  postXml: string;
  preview: ChangePreview;
}

interface ValidatedChange {
  definition: AreaDefinition;
  operation: ChangeOperation;
  id?: string;
  changedFields: readonly string[];
  values: Readonly<Record<string, unknown>>;
  preview: ChangePreview;
}

interface XmlElement {
  value?: unknown;
  children: Map<string, XmlElement>;
}

const INVALID_CHANGE_MESSAGE = 'Invalid AroFlo change input';
const PREVIEW_ONLY_WARNING = 'Preview only; no request was sent to AroFlo.';
const SENSITIVE_WARNING = 'Sensitive field values are redacted.';
const REDACTED = '[REDACTED]';
const FORBIDDEN_CONTROL_KEYS = new Set(['postxml', 'xml', 'zone', 'delete', 'archive']);

function invalidChange(): never {
  throw new Error(INVALID_CHANGE_MESSAGE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSupportedScalar(value: unknown, field: FieldDefinition): boolean {
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'date' || field.type === 'datetime') {
    return typeof value === 'string' && isValidMutationDate(value, field);
  }
  return typeof value === 'string';
}

function isValidMutationDate(value: string, field: FieldDefinition): boolean {
  if (field.mutationFormat === 'YYYY/MM/DD') {
    const match = /^(?<year>\d{4})\/(?<month>0[1-9]|1[0-2])\/(?<day>0[1-9]|[12]\d|3[01])$/.exec(value);
    return match !== null && isCalendarDate(match.groups);
  }
  if (field.mutationFormat === 'YYYY/MM/DD HH:mm:ss') {
    const match = /^(?<year>\d{4})\/(?<month>0[1-9]|1[0-2])\/(?<day>0[1-9]|[12]\d|3[01]) (?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d):(?<second>[0-5]\d)$/.exec(value);
    return match !== null && isCalendarDate(match.groups);
  }
  return false;
}

function isCalendarDate(groups: Record<string, string> | undefined): boolean {
  if (groups === undefined) return false;
  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  if (year === 0) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isBlankRequiredValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

function validateChange(input: ChangeInput): ValidatedChange {
  if (
    !isPlainRecord(input) ||
    !Object.hasOwn(input, 'area') ||
    !Object.hasOwn(input, 'operation') ||
    !Object.hasOwn(input, 'fields')
  ) invalidChange();
  if (input.operation !== 'create' && input.operation !== 'update') invalidChange();
  if (typeof input.area !== 'string') invalidChange();

  const definition = AREA_DEFINITIONS.get(input.area as Area);
  if (definition === undefined || definition.mutationEnvelope === null || !isPlainRecord(input.fields)) invalidChange();

  const declaredFields = input.operation === 'create' ? definition.createFields : definition.updateFields;
  if (declaredFields.length === 0) invalidChange();
  if (input.operation === 'create' && Object.hasOwn(input, 'id')) invalidChange();
  if (input.operation === 'update') {
    if (!Object.hasOwn(input, 'id')) invalidChange();
    const identifier = definition.fields[definition.identifier];
    if (
      identifier === undefined ||
      !isSupportedScalar(input.id, identifier) ||
      isBlankRequiredValue(input.id)
    ) {
      invalidChange();
    }
  }

  const inputFields = input.operation === 'update'
    ? declaredFields.filter((field) => field !== definition.identifier)
    : declaredFields;
  const allowedFields = new Set(inputFields);
  const suppliedFields = Object.keys(input.fields);
  if (suppliedFields.length === 0) invalidChange();

  for (const field of suppliedFields) {
    if (FORBIDDEN_CONTROL_KEYS.has(field.toLowerCase()) || !allowedFields.has(field)) invalidChange();
    const fieldDefinition = definition.fields[field];
    if (fieldDefinition === undefined || !isSupportedScalar(input.fields[field], fieldDefinition)) invalidChange();
  }

  if (input.operation === 'create') {
    for (const field of declaredFields) {
      const fieldDefinition = definition.fields[field];
      if (fieldDefinition?.requiredOnCreate !== true) continue;
      if (!Object.hasOwn(input.fields, field) || isBlankRequiredValue(input.fields[field])) invalidChange();
    }
  }

  const changedFields = Object.freeze(inputFields.filter((field) => Object.hasOwn(input.fields, field)));
  if (changedFields.length === 0) invalidChange();

  const values: Record<string, unknown> = {};
  const redactedValues: Record<string, unknown> = {};
  let containsSensitiveValue = false;
  for (const field of changedFields) {
    const value = input.fields[field];
    const fieldDefinition = definition.fields[field];
    if (fieldDefinition === undefined) invalidChange();
    values[field] = value;
    if (fieldDefinition.sensitive === true) {
      redactedValues[field] = REDACTED;
      containsSensitiveValue = true;
    } else {
      redactedValues[field] = value;
    }
  }

  const warnings = Object.freeze([
    PREVIEW_ONLY_WARNING,
    ...(containsSensitiveValue ? [SENSITIVE_WARNING] : [])
  ]);
  const preview = Object.freeze({
    area: definition.area,
    operation: input.operation,
    ...(input.operation === 'update' ? { id: input.id } : {}),
    changedFields,
    redactedValues: Object.freeze(redactedValues),
    warnings
  }) as ChangePreview;

  return {
    definition,
    operation: input.operation,
    ...(input.operation === 'update' ? { id: input.id } : {}),
    changedFields,
    values: Object.freeze(values),
    preview,
  };
}

function safelyValidate(input: ChangeInput): ValidatedChange {
  try {
    return validateChange(input);
  } catch {
    return invalidChange();
  }
}

function xmlEscape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function addElement(root: XmlElement, path: readonly string[], value: unknown): void {
  let current = root;
  for (const elementName of path) {
    let child = current.children.get(elementName);
    if (child === undefined) {
      child = { children: new Map() };
      current.children.set(elementName, child);
    }
    current = child;
  }
  current.value = value;
}

function serializeChildren(element: XmlElement): string {
  let xml = '';
  for (const [name, child] of element.children) {
    const content = child.children.size === 0 ? xmlEscape(child.value) : serializeChildren(child);
    xml += `<${name}>${content}</${name}>`;
  }
  return xml;
}

function compilePostXml(change: ValidatedChange): string {
  const record: XmlElement = { children: new Map() };

  if (change.operation === 'update') {
    const identifier = change.definition.fields[change.definition.identifier];
    if (identifier === undefined) invalidChange();
    addElement(record, identifier.apiName.split('.'), change.id);
  }

  for (const field of change.changedFields) {
    const definition = change.definition.fields[field];
    if (definition === undefined) invalidChange();
    addElement(record, definition.apiName.split('.'), change.values[field]);
  }

  const envelope = change.definition.mutationEnvelope;
  if (envelope === null) invalidChange();
  return `<${envelope.root}><${envelope.record}>${serializeChildren(record)}</${envelope.record}></${envelope.root}>`;
}

export function previewChange(input: ChangeInput): ChangePreview {
  return safelyValidate(input).preview;
}

export function compileChange(input: ChangeInput): CompiledChange {
  const change = safelyValidate(input);
  return Object.freeze({
    zone: change.definition.zone,
    postXml: compilePostXml(change),
    preview: change.preview
  });
}
