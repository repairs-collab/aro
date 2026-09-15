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
const XML_TEXT = `A & B <C> "D" 'E'`;
const ESCAPED_XML_TEXT = 'A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;';

const operationFields = [
  ['create task', 'taskname'],
  ['update task', 'taskname'],
  ['create client', 'clientname'],
  ['update client', 'phone'],
  ['update invoice', 'description'],
  ['create schedule', 'note'],
  ['create user', 'givennames'],
  ['update user', 'mobile'],
  ['create asset', 'assetname'],
  ['update asset', 'location.locationid'],
  ['create inventory item', 'partnumber'],
  ['update inventory item', 'stocklevels.stocklevel.assignedtotype']
] as const;

const operationCases = operationFields.map(([name, scalarField]) => {
  const fixture = changeCases.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`Missing fixture: ${name}`);
  return { ...fixture, scalarField };
});

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

  it.each(changeCases)('rejects an unsupported field for $name', ({ input }) => {
    expect(() => changeCompiler.compileChange({ ...input, fields: { totallyUnknown: 'value' } })).toThrow(INVALID_MESSAGE);
  });

  it.each(changeCases)('rejects an empty mutation for $name', ({ input }) => {
    expect(() => changeCompiler.compileChange({ ...input, fields: {} })).toThrow(INVALID_MESSAGE);
  });

  it.each(operationCases)('rejects the wrong scalar type for $name without coercion', ({ input, scalarField }) => {
    expect(() => changeCompiler.compileChange({
      ...input,
      fields: { ...input.fields, [scalarField]: 123 }
    })).toThrow(INVALID_MESSAGE);
  });

  it.each(operationCases)('escapes all five XML-sensitive characters for $name', ({ input, scalarField }) => {
    const compiled = changeCompiler.compileChange({
      ...input,
      fields: { ...input.fields, [scalarField]: XML_TEXT }
    });

    expect(compiled.postXml).toContain(ESCAPED_XML_TEXT);
    expect(compiled.postXml).not.toContain(XML_TEXT);
  });

  it.each([
    ['null', '\u0000'],
    ['vertical tab', '\u000b'],
    ['unit separator', '\u001f'],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
    ['noncharacter FFFE', '\ufffe'],
    ['noncharacter FFFF', '\uffff']
  ])('rejects XML 1.0-invalid %s characters before preview or compilation', (_name, invalidCharacter) => {
    const input = {
      area: 'tasks' as const,
      operation: 'update' as const,
      id: 'task-1',
      fields: { taskname: `before${invalidCharacter}after` }
    };

    expect(() => changeCompiler.previewChange(input)).toThrow(INVALID_MESSAGE);
    expect(() => changeCompiler.compileChange(input)).toThrow(INVALID_MESSAGE);
    expect(() => changeCompiler.compileChange({ ...input, id: `task${invalidCharacter}1`, fields: { taskname: 'valid' } }))
      .toThrow(INVALID_MESSAGE);
  });

  it('accepts valid supplementary Unicode XML text', () => {
    expect(changeCompiler.compileChange({
      area: 'tasks', operation: 'update', id: 'task-1', fields: { taskname: 'Valid \ud83d\ude00 text' }
    }).postXml).toContain('<taskname>Valid \ud83d\ude00 text</taskname>');
  });

  it.each(operationCases)('rejects every forbidden control key for $name', ({ input }) => {
    for (const key of ['postxml', 'xml', 'zone', 'delete', 'archive']) {
      expect(() => changeCompiler.compileChange({
        ...input,
        fields: { ...input.fields, [key]: 'never-reflect-control-value' }
      })).toThrow(INVALID_MESSAGE);
    }
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
    'does not reflect the forbidden control key %s value in its error',
    (key) => {
      const secret = 'never-reflect-control-value';
      const invalid = () => changeCompiler.compileChange({
        area: 'tasks', operation: 'update', id: 'task-1', fields: { [key]: secret }
      });

      expect(invalid).toThrow(INVALID_MESSAGE);
      expect(invalid).toThrowError(expect.not.stringContaining(secret));
    }
  );

  it('rejects API fields undeclared for the operation', () => {
    const cases = [
      { area: 'tasks', operation: 'update', id: 'task-1', fields: { jobnumber: 42 } },
      { area: 'clients', operation: 'update', id: 'client-1', fields: { email: 'private@example.test' } }
    ] as const;

    for (const input of cases) expect(() => changeCompiler.compileChange(input)).toThrow(INVALID_MESSAGE);
  });

  it.each(operationCases)('rejects an identifier supplied through fields for $name', ({ input }) => {
    const identifier = AREA_DEFINITIONS.get(input.area)?.identifier;
    if (identifier === undefined) throw new Error(`Missing identifier for ${input.area}`);
    expect(() => changeCompiler.compileChange({
      ...input,
      fields: { ...input.fields, [identifier]: 'identifier-in-fields' }
    })).toThrow(INVALID_MESSAGE);
  });

  it.each([
    ['tasks', 'duedate', '2026-09-11'],
    ['tasks', 'duedate', '2026/02/30'],
    ['tasks', 'duedate', '0000/01/01'],
    ['assets', 'datecreated', '2026/13/01'],
    ['assets', 'datecreated', '2026/04/31'],
    ['schedules', 'startdate', '2026-09-11'],
    ['schedules', 'enddate', '2026/02/29'],
    ['schedules', 'startdatetime', '2026/09/11T07:00:00'],
    ['schedules', 'startdatetime', '2026/09/11 24:00:00'],
    ['schedules', 'enddatetime', '2026/09/11 09:00:60']
  ] as const)('rejects invalid documented mutation date format/calendar value for %s.%s', (area, field, value) => {
    const fixture = changeCases.find(({ input }) => input.area === area && input.operation === 'create');
    if (fixture === undefined) throw new Error('Missing create fixture');

    expect(() => changeCompiler.compileChange({
      ...fixture.input,
      fields: { ...fixture.input.fields, [field]: value }
    })).toThrow(INVALID_MESSAGE);
  });

  it('accepts leap-day values in each documented mutation date format', () => {
    const task = changeCases.find(({ name }) => name === 'create task');
    const schedule = changeCases.find(({ name }) => name === 'create schedule');
    if (task === undefined || schedule === undefined) throw new Error('Missing date fixture');

    expect(changeCompiler.compileChange({
      ...task.input,
      fields: { ...task.input.fields, duedate: '2028/02/29' }
    }).postXml).toContain('<duedate>2028/02/29</duedate>');
    expect(changeCompiler.compileChange({
      ...schedule.input,
      fields: { ...schedule.input.fields, startdatetime: '2028/02/29 23:59:59' }
    }).postXml).toContain('<startdatetime>2028/02/29 23:59:59</startdatetime>');
  });

  it('accepts valid zero-padded years in each documented mutation date format', () => {
    const task = changeCases.find(({ name }) => name === 'create task');
    const schedule = changeCases.find(({ name }) => name === 'create schedule');
    if (task === undefined || schedule === undefined) throw new Error('Missing date fixture');

    expect(changeCompiler.compileChange({
      ...task.input,
      fields: { ...task.input.fields, duedate: '0001/01/01' }
    }).postXml).toContain('<duedate>0001/01/01</duedate>');
    expect(changeCompiler.compileChange({
      ...schedule.input,
      fields: { ...schedule.input.fields, startdatetime: '0004/02/29 00:00:00' }
    }).postXml).toContain('<startdatetime>0004/02/29 00:00:00</startdatetime>');
  });

  it('requires own structural properties and rejects polluted input prototypes', () => {
    const task = changeCases.find(({ name }) => name === 'update task');
    if (task?.input.id === undefined) throw new Error('Missing update task fixture');

    const inheritedArea = Object.assign(Object.create({ area: 'tasks' }), {
      operation: 'update', id: task.input.id, fields: task.input.fields
    });
    const inheritedOperation = Object.assign(Object.create({ operation: 'update' }), {
      area: 'tasks', id: task.input.id, fields: task.input.fields
    });
    const inheritedFields = Object.assign(Object.create({ fields: task.input.fields }), {
      area: 'tasks', operation: 'update', id: task.input.id
    });
    const inheritedId = Object.assign(Object.create({ id: task.input.id }), {
      area: 'tasks', operation: 'update', fields: task.input.fields
    });
    const pollutedFields = Object.assign(Object.create({ zone: 'users' }), task.input.fields);
    const explicitUndefinedCreateId = {
      area: 'clients', operation: 'create', id: undefined,
      fields: { clientname: 'Client', firstname: 'Jane', surname: 'Doe' }
    };

    for (const input of [inheritedArea, inheritedOperation, inheritedFields, inheritedId]) {
      expect(() => changeCompiler.compileChange(input)).toThrow(INVALID_MESSAGE);
    }
    expect(() => changeCompiler.compileChange({ ...task.input, fields: pollutedFields })).toThrow(INVALID_MESSAGE);
    expect(() => changeCompiler.compileChange(explicitUndefinedCreateId as never)).toThrow(INVALID_MESSAGE);
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
