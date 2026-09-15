import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('plugin scaffold', () => {
  it('pins the runtime and contains no populated secret defaults', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const sample = await readFile('.env.example', 'utf8');

    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('2.0.0');
    expect(sample).toContain('AROFLO_WRITE_ENABLED=false');
    expect(sample).not.toMatch(/AROFLO_(?:UENCODED|PENCODED|ORG_ENCODED|SECRET_KEY)=\S+/);
  });

  it('provides an intentional side-effect-free public connector entry point', async () => {
    const connector = await import('../../src/index.js');

    expect(Object.keys(connector)).toEqual(expect.arrayContaining([
      'AroFloClient',
      'buildMcpServer',
      'compileChange',
      'describeArea',
      'loadConfig',
      'previewChange'
    ]));
  });
});
