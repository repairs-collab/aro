import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AREAS } from '../../src/config.js';
import {
  AREA_DEFINITIONS,
  compileReadQuery,
  describeArea,
  getAreaDefinition,
  isFinancialArea
} from '../../src/aroflo/area-registry.js';
import { encodePairs } from '../../src/aroflo/query.js';

const officialContracts = JSON.parse(
  readFileSync(new URL('../fixtures/official-contract-summary.json', import.meta.url), 'utf8')
) as Record<
  string,
  {
    zone: string;
    identifier: string;
    fields: string[];
    filters: string[];
    joins: string[];
    createFields: string[];
    updateFields: string[];
  }
>;

describe('AroFlo area registry', () => {
  it('matches the nine-area public contract summary and keeps every reference internally valid', () => {
    expect(Object.keys(officialContracts)).toEqual([...AREAS]);
    expect([...AREA_DEFINITIONS.keys()]).toEqual([...AREAS]);

    for (const area of AREAS) {
      const contract = getAreaDefinition(area);
      const source = officialContracts[area];
      if (source === undefined) throw new Error('Missing public contract fixture');

      expect(contract.zone).toBe(source.zone);
      expect(contract.identifier).toBe(source.identifier);
      expect(contract.zone).not.toBe('');
      expect(contract.identifier).not.toBe('');
      expect(Object.keys(contract.fields)).toEqual(source.fields);
      expect(Object.keys(contract.filters)).toEqual(source.filters);
      expect(contract.joins).toEqual(source.joins);
      expect(contract.createFields).toEqual(source.createFields);
      expect(contract.updateFields).toEqual(source.updateFields);
      expect(describeArea(area).fields).toEqual(source.fields);

      for (const field of Object.keys(contract.filters)) expect(contract.fields[field]).toBeDefined();
      for (const field of [...contract.createFields, ...contract.updateFields]) expect(contract.fields[field]).toBeDefined();
      expect(new Set(contract.joins).size).toBe(contract.joins.length);
    }
  });

  it('emits a bounded, ordered and wire-encodable query from allowlisted input', () => {
    const pairs = compileReadQuery({
      area: 'tasks',
      filters: [
        { field: 'jobnumber', operator: 'eq', value: 'Job & Co' },
        { field: 'duedate', operator: 'gte', value: '2026-01-01' }
      ],
      joins: ['notes', 'project'],
      order: { field: 'duedate', direction: 'desc' },
      page: 2,
      pageSize: 25
    });

    expect(pairs).toEqual([
      ['zone', 'tasks'],
      ['where', 'and|jobnumber|=|Job & Co'],
      ['where', 'and|duedate|>=|2026-01-01'],
      ['join', 'notes'],
      ['join', 'project'],
      ['order', 'duedate|desc'],
      ['page', 2],
      ['pageSize', 25]
    ]);
    expect(encodePairs(pairs)).toContain('Job%20%26%20Co');
  });

  it('rejects unsupported input and never reflects unsafe fragments in validation errors', () => {
    const unsafe = 'bad&zone=users';
    const cases = [
      () => getAreaDefinition(unsafe as never),
      () => compileReadQuery({ area: 'tasks', filters: [{ field: unsafe, operator: 'eq', value: 'x' }] }),
      () => compileReadQuery({ area: 'tasks', filters: [{ field: 'jobnumber', operator: 'contains', value: 'x' }] }),
      () => compileReadQuery({ area: 'tasks', joins: [unsafe] }),
      () => compileReadQuery({ area: 'tasks', order: { field: unsafe, direction: 'asc' } }),
      () => compileReadQuery({ area: 'tasks', order: { field: 'jobnumber', direction: 'up' as never } }),
      () => compileReadQuery({ area: 'tasks', page: 0 }),
      () => compileReadQuery({ area: 'tasks', pageSize: 101 }),
      () => compileReadQuery({ area: 'tasks', filters: Array.from({ length: 11 }, () => ({ field: 'jobnumber', operator: 'eq' as const, value: 'x' })) }),
      () => compileReadQuery({ area: 'tasks', joins: Array.from({ length: 6 }, () => 'notes') })
    ];

    for (const invalid of cases) {
      expect(invalid).toThrow('Invalid AroFlo search input');
      expect(invalid).toThrowError(expect.not.stringContaining(unsafe));
    }
  });

  it('continues to classify invoices as financial', () => {
    expect(isFinancialArea('invoices')).toBe(true);
    expect(isFinancialArea('tasks')).toBe(false);
  });
});
