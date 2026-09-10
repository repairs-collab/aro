import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AREA_DEFINITIONS } from '../../src/aroflo/area-registry.js';
import * as changeCompiler from '../../src/aroflo/change-compiler.js';
import type { Area } from '../../src/config.js';

interface FixtureCase {
  name: string;
  input: {
    area: Area;
    operation: 'create' | 'update';
    id?: string;
    fields: Record<string, unknown>;
  };
  postXml: string;
  changedFields: string[];
}

const changeCases = JSON.parse(
  readFileSync(new URL('../fixtures/change-cases.json', import.meta.url), 'utf8')
) as FixtureCase[];

const INVALID_MESSAGE = 'Invalid AroFlo change input';
const PREVIEW_WARNING = 'Preview only; no request was sent to AroFlo.';

describe('AroFlo structured change compiler', () => {
  it.each(changeCases)('compiles the documented $name envelope from registry-ordered fields', ({ input, postXml, changedFields }) => {
    const compiled = changeCompiler.compileChange(input);

    expect(compiled.zone).toBe(AREA_DEFINITIONS.get(input.area)?.zone);
    expect(compiled.postXml).toBe(postXml);
    expect(compiled.preview).toEqual({
      area: input.area,
      operation: input.operation,
      ...(input.id === undefined ? {} : { id: input.id }),
      changedFields,
      redactedValues: input.area === 'users' && input.operation === 'create'
        ? {
            givennames: 'Jane',
            surname: 'Doe',
            username: 'jane.doe',
            password: '[REDACTED]',
            accesstype: 'Use Permission Groups',
            'org.orgid': 'org-1'
          }
        : Object.fromEntries(changedFields.map((field) => [field, input.fields[field]])),
      warnings: input.area === 'users' && input.operation === 'create'
        ? [PREVIEW_WARNING, 'Sensitive field values are redacted.']
        : [PREVIEW_WARNING]
    });
  });

  it('uses the same validation and redacted result path for preview without exposing XML', () => {
    const input = changeCases.find(({ name }) => name === 'create user')?.input;
    if (input === undefined) throw new Error('Missing create user fixture');

    const preview = changeCompiler.previewChange(input);

    expect(preview).toEqual(changeCompiler.compileChange(input).preview);
    expect(preview.redactedValues.password).toBe('[REDACTED]');
    expect(JSON.stringify(preview)).not.toContain('private-password');
    expect(preview).not.toHaveProperty('postXml');
    expect(JSON.stringify(preview)).not.toMatch(/<users>|&lt;users&gt;/);
  });

  it.each([
    ['tasks', ['client.clientid', 'org.orgid', 'taskname', 'tasktype.tasktypeid']],
    ['clients', ['clientname', 'firstname', 'surname']],
    ['schedules', ['enddate', 'enddatetime', 'insertedby.userid', 'scheduledto.scheduledtoid', 'scheduledto.scheduledtotype', 'scheduletype.type', 'scheduletype.typeid', 'startdate', 'startdatetime']],
    ['users', ['accesstype', 'givennames', 'org.orgid', 'password', 'surname', 'username']],
    ['assets', ['assetname', 'category.categoryid']],
    ['inventory', ['category.categoryid', 'costex', 'description', 'partnumber', 'sellsimple']]
  ] as const)('rejects a %s create when each required registry field is missing or blank', (area, requiredFields) => {
    const fixture = changeCases.find(({ input }) => input.area === area && input.operation === 'create');
    if (fixture === undefined) throw new Error('Missing create fixture');

    for (const requiredField of requiredFields) {
      const fields = { ...fixture.input.fields };
      delete fields[requiredField];
      expect(() => changeCompiler.compileChange({ area, operation: 'create', fields })).toThrow(INVALID_MESSAGE);
      expect(() => changeCompiler.compileChange({ area, operation: 'create', fields: { ...fixture.input.fields, [requiredField]: '   ' } })).toThrow(INVALID_MESSAGE);
    }
  });

  it.each(['tasks', 'clients', 'invoices', 'users', 'assets', 'inventory'] as const)(
    'rejects a %s update without a non-empty string record identifier',
    (area) => {
      const fixture = changeCases.find(({ input }) => input.area === area && input.operation === 'update');
      if (fixture === undefined) throw new Error('Missing update fixture');

      expect(() => changeCompiler.compileChange({ area, operation: 'update', fields: fixture.input.fields })).toThrow(INVALID_MESSAGE);
      expect(() => changeCompiler.compileChange({ area, operation: 'update', id: '', fields: fixture.input.fields })).toThrow(INVALID_MESSAGE);
      expect(() => changeCompiler.compileChange({ area, operation: 'update', id: 123 as never, fields: fixture.input.fields })).toThrow(INVALID_MESSAGE);
    }
  );

  it.each(changeCases)('rejects unsupported and empty fields for $name', ({ input }) => {
    expect(() => changeCompiler.compileChange({ ...input, fields: { totallyUnknown: 'value' } })).toThrow(INVALID_MESSAGE);
    expect(() => changeCompiler.compileChange({ ...input, fields: {} })).toThrow(INVALID_MESSAGE);
  });

  it('rejects wrong scalar types without coercion', () => {
    const invalid = [
      { area: 'tasks', operation: 'update', id: 'task-1', fields: { taskname: 123 } },
      { area: 'assets', operation: 'create', fields: { assetname: 'Pump', 'category.categoryid': 'cat-1', datecreated: false } },
      {
        area: 'schedules', operation: 'create', fields: {
          'scheduletype.typeid': 'type-1', 'scheduletype.type': 'task', startdate: '2026/09/11',
          'insertedby.userid': 'user-1', enddate: '2026/09/11', enddatetime: 9,
          'scheduledto.scheduledtoid': 'user-2', 'scheduledto.scheduledtotype': 'user', startdatetime: '2026/09/11 07:00:00'
        }
      },
      {
        area: 'inventory', operation: 'create', fields: {
          partnumber: 'ABC', description: 'Cable', costex: '10', sellsimple: 20, 'category.categoryid': 'cat-1'
        }
      },
      {
        area: 'inventory', operation: 'update', id: 'item-1',
        fields: { 'stocklevels.stocklevel.movequantity': Number.NaN }
      }
    ] as const;

    for (const input of invalid) expect(() => changeCompiler.compileChange(input)).toThrow(INVALID_MESSAGE);
  });

  it('rejects read-only operations, unknown areas, unknown operations, and malformed field collections', () => {
    const invalid = [
      { area: 'locations', operation: 'create', fields: { locationname: 'X' } },
      { area: 'locations', operation: 'update', id: 'loc-1', fields: { locationname: 'X' } },
      { area: 'quotes', operation: 'create', fields: { quotename: 'X' } },
      { area: 'quotes', operation: 'update', id: 'quote-1', fields: { status: 'X' } },
      { area: 'unknown', operation: 'create', fields: { taskname: 'X' } },
      { area: 'tasks', operation: 'delete', id: 'task-1', fields: { status: 'X' } },
      { area: 'tasks', operation: 'update', id: 'task-1', fields: null },
      { area: 'tasks', operation: 'update', id: 'task-1', fields: [] }
    ] as unknown[];

    for (const input of invalid) expect(() => changeCompiler.compileChange(input as never)).toThrow(INVALID_MESSAGE);
  });

  it.each(['postxml', 'xml', 'zone', 'delete', 'archive'])(
    'rejects the forbidden control key %s without reflecting its value',
    (key) => {
      const secret = 'never-reflect-control-value';
      const invalid = () => changeCompiler.compileChange({
        area: 'tasks', operation: 'update', id: 'task-1', fields: { [key]: secret }
      });

      expect(invalid).toThrow(INVALID_MESSAGE);
      expect(invalid).toThrowError(expect.not.stringContaining(secret));
    }
  );

  it('rejects API fields undeclared for the operation and identifier injection through fields', () => {
    const cases = [
      { area: 'tasks', operation: 'create', fields: { taskid: 'injected' } },
      { area: 'tasks', operation: 'update', id: 'task-1', fields: { jobnumber: 42 } },
      { area: 'clients', operation: 'update', id: 'client-1', fields: { email: 'private@example.test' } }
    ] as const;

    for (const input of cases) expect(() => changeCompiler.compileChange(input)).toThrow(INVALID_MESSAGE);
  });

  it('never reflects sensitive values in validation errors', () => {
    const sensitive = 'sensitive-password-value';
    const invalid = () => changeCompiler.previewChange({
      area: 'users', operation: 'create', fields: {
        givennames: 'Jane', surname: 'Doe', username: 'jane.doe', password: sensitive,
        accesstype: 'Use Permission Groups', 'org.orgid': 'org-1', xml: '<unsafe />'
      }
    });

    expect(invalid).toThrow(INVALID_MESSAGE);
    expect(invalid).toThrowError(expect.not.stringContaining(sensitive));
    expect(invalid).toThrowError(expect.not.stringContaining('<unsafe />'));
  });

  it('exports only the structured compiler entry points', () => {
    expect(Object.keys(changeCompiler).sort()).toEqual(['compileChange', 'previewChange']);
  });
});
