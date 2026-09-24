import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('plugin scaffold', () => {
  it('pins the runtime and contains no populated secret defaults', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const plugin = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
    const sample = await readFile('.env.example', 'utf8');
    const v2ApiTokenName = ['AROFLO', 'V2', 'API', 'TOKEN'].join('_');

    expect(pkg.version).toBe('0.2.0');
    expect(plugin.version).toBe('0.2.0');
    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('2.0.0');
    expect(sample).toContain('AROFLO_WRITE_ENABLED=false');
    expect(sample).toContain(`${v2ApiTokenName}=`);
    expect(sample).toContain('AROFLO_V2_SMOKE_BUSINESS_UNIT_ID=');
    expect(sample).not.toMatch(new RegExp(`${v2ApiTokenName}=\\S+`));
    expect(sample).not.toMatch(/AROFLO_V2_SMOKE_BUSINESS_UNIT_ID=\S+/);
    expect(sample).not.toMatch(/AROFLO_(?:UENCODED|PENCODED|ORG_ENCODED|SECRET_KEY)=\S+/);
  });

  it('provides an intentional side-effect-free public connector entry point', async () => {
    const connector = await import('../../src/index.js');

    expect(Object.keys(connector)).toEqual(expect.arrayContaining([
      'AroFloClient',
      'AroFloV2Client',
      'INVOICE_LAYOUTS',
      'INVOICE_TYPES',
      'V2ConfirmationStore',
      'buildMcpServer',
      'compileChange',
      'describeArea',
      'loadConfig',
      'previewChange'
    ]));
  });
});
