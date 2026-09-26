import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('plugin scaffold', () => {
  it('runs release checks from verified built artifacts without invoking the compiler', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const releaseChecks = {
      'smoke:read-only': pkg.scripts['smoke:read-only'],
      'smoke:v2-read-only': pkg.scripts['smoke:v2-read-only'],
      'scan:secrets': pkg.scripts['scan:secrets']
    };

    expect(releaseChecks).toEqual({
      'smoke:read-only': 'node dist/scripts/read-only-smoke-test.js',
      'smoke:v2-read-only': 'node dist/scripts/v2-read-only-smoke-test.js',
      'scan:secrets': 'node dist/scripts/secret-scan.js'
    });
    expect(Object.values(releaseChecks).every((command) => !/\btsc\b/.test(command))).toBe(true);
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.json');
    expect(pkg.scripts.typecheck).toBe('tsc -p tsconfig.json --noEmit');
    expect(pkg.version).toBe('0.2.0');
  });

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
