import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_PATHS,
  MAX_SCAN_FILE_BYTES,
  scanFiles,
  scanPathsForCli
} from '../../scripts/secret-scan.js';
import * as secretScanner from '../../scripts/secret-scan.js';

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aroflo-secret-scan-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('secret scanner', () => {
  it('reports filenames and categories across source, build, docs, manifests, MCP config, and extracted archives without values', async () => {
    const root = await temporaryRoot();
    const sensitive = 'fake-sensitive-value-for-test';
    const credentialName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    const authorizationName = ['Author', 'ization'].join('');
    const authenticationName = ['Authenti', 'cation'].join('');
    const privateKeyStart = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const privateKeyEnd = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const files = [
      ['src/index.ts', `const marker = '${sensitive}';`],
      ['dist/src/index.js', `const ${authorizationName} = "Bearer QWxwaGFCZXRhR2FtbWE=";`],
      ['docs/guide.md', `${credentialName}=generated-unit-value`],
      ['.codex-plugin/plugin.json', `{"${authenticationName}":"HMAC 0123456789abcdef0123456789abcdef"}`],
      ['.mcp.json', `{"header":"${authorizationName}: Basic QWxwaGFCZXRhR2FtbWE="}`],
      ['outputs/extracted/DEPLOYMENT.md', `${privateKeyStart}\ngenerated-unit-material\n${privateKeyEnd}`]
    ] as const;
    for (const [relative, contents] of files) {
      await mkdir(join(root, relative, '..'), { recursive: true });
      await writeFile(join(root, relative), contents, 'utf8');
    }

    const result = await scanFiles([root], [sensitive, '', '   ']);
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.file.replaceAll('\\', '/'))).toEqual(expect.arrayContaining(
      files.map(([relative]) => relative)
    ));
    expect(result.findings.flatMap((finding) => finding.categories)).toEqual(expect.arrayContaining([
      'sensitive-value',
      'authorization-header',
      'populated-credential',
      'authentication-signature',
      'private-key'
    ]));
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain('generated-unit-value');
    expect(serialized).not.toContain('QWxwaGFCZXRhR2FtbWE');
  });

  it('flags real dotenv files, unsupported binary text, and links while allowing the blank example and skipping .git and node_modules', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const secretName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    const userName = ['AROFLO', 'UENCODED'].join('_');
    const passwordName = ['AROFLO', 'PENCODED'].join('_');
    const organizationName = ['AROFLO', 'ORG', 'ENCODED'].join('_');
    await writeFile(join(root, '.env.example'), `${secretName}=\n`, 'utf8');
    await writeFile(join(root, '.env.local'), 'PLACEHOLDER=only-a-placeholder', 'utf8');
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'package'), { recursive: true });
    await writeFile(join(root, '.git', 'secret.txt'), `${userName}=should-be-skipped`, 'utf8');
    await writeFile(join(root, 'node_modules', 'package', 'secret.txt'), `${passwordName}=should-be-skipped`, 'utf8');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255, 1, 2, 3]));
    await writeFile(join(outside, 'outside.txt'), `${organizationName}=must-not-be-followed`, 'utf8');
    await symlink(outside, join(root, 'linked-directory'), 'junction');

    const result = await scanFiles([root], []);

    expect(result.findings).toEqual([
      { file: '.env.local', categories: ['dotenv-file'] },
      { file: 'binary.bin', categories: ['unsupported-text'] },
      { file: 'linked-directory', categories: ['linked-path'] }
    ]);
    expect(result.scannedFiles).toBe(3);
    expect(result.findings.every((finding) => !['secret.txt', 'outside.txt'].includes(basename(finding.file)))).toBe(true);
  });

  it('returns deterministic clean results and never writes matched material into files', async () => {
    const root = await temporaryRoot();
    const cleanFile = join(root, 'README.md');
    const secretName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    const authorizationName = ['Author', 'ization'].join('');
    await writeFile(cleanFile, `${secretName}=\n${authorizationName} header names are documented without values.\n`, 'utf8');

    const before = await readFile(cleanFile, 'utf8');
    const result = await scanFiles([cleanFile], ['']);

    expect(result).toEqual({ ok: true, scannedFiles: 1, findings: [] });
    expect(await readFile(cleanFile, 'utf8')).toBe(before);
  });

  it('continues past placeholder matches to find a later populated header and signature', async () => {
    const root = await temporaryRoot();
    const authorizationName = ['Author', 'ization'].join('');
    const authenticationName = ['Authenti', 'cation'].join('');
    await writeFile(join(root, 'mixed.txt'), [
      `${authorizationName}: Bearer fake-placeholder`,
      `${authorizationName}: Bearer QWxwaGFCZXRhR2FtbWE=`,
      `${authenticationName}: HMAC aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      `${authenticationName}: HMAC 0123456789abcdef0123456789abcdef`
    ].join('\n'), 'utf8');

    const result = await scanFiles([root], []);

    expect(result.findings).toEqual([{
      file: 'mixed.txt',
      categories: ['authorization-header', 'authentication-signature']
    }]);
  });

  it('detects populated credential assignments in JSON and quoted or unquoted YAML for every secret name', async () => {
    const root = await temporaryRoot();
    const credentialNames = [
      ['AROFLO', 'UENCODED'].join('_'),
      ['AROFLO', 'PENCODED'].join('_'),
      ['AROFLO', 'ORG', 'ENCODED'].join('_'),
      ['AROFLO', 'SECRET', 'KEY'].join('_'),
      ['MCP', 'ACCESS', 'TOKEN'].join('_')
    ];
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify(Object.fromEntries(credentialNames.map((name, index) => [name, `generated-json-${index}`]))),
      'utf8'
    );
    await writeFile(
      join(root, 'config.yaml'),
      credentialNames.map((name, index) => index % 2 === 0
        ? `"${name}": "generated-yaml-${index}"`
        : `${name}: generated-yaml-${index}`).join('\n'),
      'utf8'
    );

    const result = await scanFiles([root], []);

    expect(result.findings).toEqual([
      { file: 'config.json', categories: ['populated-credential'] },
      { file: 'config.yaml', categories: ['populated-credential'] }
    ]);
  });

  it('does not exempt secret-looking values merely because they begin with test or private', async () => {
    const root = await temporaryRoot();
    const secretName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    const tokenName = ['MCP', 'ACCESS', 'TOKEN'].join('_');
    await writeFile(join(root, 'prefixed.env.example'), [
      `${secretName}=test-real-looking-secret`,
      `${tokenName}=private-production-key`
    ].join('\n'), 'utf8');

    const result = await scanFiles([root], []);

    expect(result.findings).toEqual([{
      file: 'prefixed.env.example',
      categories: ['populated-credential']
    }]);
  });

  it('always reports an exact current-environment value even when it is an explicit fixture placeholder', async () => {
    const root = await temporaryRoot();
    const userName = ['AROFLO', 'UENCODED'].join('_');
    await writeFile(join(root, 'fixture.txt'), `${userName}=fake-user`, 'utf8');

    const result = await scanFiles([root], ['fake-user']);

    expect(result.findings).toEqual([{
      file: 'fixture.txt',
      categories: ['sensitive-value']
    }]);
  });

  it('fails closed with a filename-only finding when an explicitly requested path is missing', async () => {
    const root = await temporaryRoot();
    const missing = join(root, 'missing-extracted-archive');

    const result = await scanFiles([missing], ['must-not-appear']);

    expect(result).toEqual({
      ok: false,
      scannedFiles: 0,
      findings: [{ file: 'missing-extracted-archive', categories: ['missing-path'] }]
    });
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
  });

  it('includes every required tracked root configuration in the default CLI scan paths', () => {
    expect(DEFAULT_SCAN_PATHS).toEqual(expect.arrayContaining([
      'src',
      'scripts',
      'tests',
      'dist',
      'docs',
      'skills',
      '.codex-plugin',
      '.mcp.json',
      '.env.example',
      '.dockerignore',
      '.gitignore',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'vitest.config.ts',
      'README.md',
      'DEPLOYMENT.md',
      'Dockerfile'
    ]));
    expect(DEFAULT_SCAN_PATHS).not.toContain('pnpm-workspace.yaml');
    expect(DEFAULT_SCAN_PATHS).not.toContain('outputs');
  });

  it('runs the default scan from a built standalone allowlisted package without a workspace file', async () => {
    const root = await temporaryRoot();
    const directories = ['src', 'scripts', 'tests', 'dist', 'docs', 'skills', '.codex-plugin'];
    const files = [
      '.mcp.json', '.env.example', '.dockerignore', '.gitignore', 'package.json', 'pnpm-lock.yaml',
      'tsconfig.json', 'vitest.config.ts', 'README.md', 'DEPLOYMENT.md', 'Dockerfile'
    ];
    await Promise.all(directories.map((directory) => mkdir(join(root, directory), { recursive: true })));
    await Promise.all(files.map((file) => writeFile(join(root, file), '', 'utf8')));

    const result = await scanFiles(DEFAULT_SCAN_PATHS.map((path) => join(root, path)), []);

    expect(result).toEqual({ ok: true, scannedFiles: files.length, findings: [] });
  });

  it('adds the optional workspace policy to source scans only when that file exists', async () => {
    const sourceRoot = await temporaryRoot();
    const standaloneRoot = await temporaryRoot();
    await writeFile(join(sourceRoot, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n', 'utf8');

    expect(scanPathsForCli([], sourceRoot)).toEqual([
      ...DEFAULT_SCAN_PATHS,
      join(sourceRoot, 'pnpm-workspace.yaml')
    ]);
    expect(scanPathsForCli([], standaloneRoot)).toEqual(DEFAULT_SCAN_PATHS);
  });

  it('treats AROFLO_HOST_IP as an exact current-environment sensitive value', async () => {
    expect(secretScanner).toHaveProperty('scanCurrentEnvironment');
    const scanCurrentEnvironment = (secretScanner as unknown as {
      scanCurrentEnvironment(paths: readonly string[], env: NodeJS.ProcessEnv): ReturnType<typeof scanFiles>;
    }).scanCurrentEnvironment;
    const root = await temporaryRoot();
    const sensitive = '198.51.100.77';
    await writeFile(join(root, 'host.txt'), `configured host ${sensitive}`, 'utf8');

    const result = await scanCurrentEnvironment([root], { AROFLO_HOST_IP: sensitive });

    expect(result.findings).toEqual([{ file: 'host.txt', categories: ['sensitive-value'] }]);
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('treats AROFLO_V2_API_TOKEN as an exact current-environment sensitive value', async () => {
    expect(secretScanner).toHaveProperty('scanCurrentEnvironment');
    const scanCurrentEnvironment = (secretScanner as unknown as {
      scanCurrentEnvironment(paths: readonly string[], env: NodeJS.ProcessEnv): ReturnType<typeof scanFiles>;
    }).scanCurrentEnvironment;
    const root = await temporaryRoot();
    const sensitive = 'generated-v2-api-sensitive-value';
    await writeFile(join(root, 'v2-token.txt'), `configured token ${sensitive}`, 'utf8');

    const result = await scanCurrentEnvironment([root], { AROFLO_V2_API_TOKEN: sensitive });

    expect(result.findings).toEqual([{ file: 'v2-token.txt', categories: ['sensitive-value'] }]);
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('adds caller-supplied extracted archive trees to the CLI scan paths', async () => {
    const standaloneRoot = await temporaryRoot();
    expect(scanPathsForCli(['delivery-extracted'], standaloneRoot)).toEqual([
      ...DEFAULT_SCAN_PATHS,
      'delivery-extracted'
    ]);
  });

  it('normalizes the single leading separator forwarded by the documented pnpm command and scans its extra path', async () => {
    const root = await temporaryRoot();
    const secretName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    await writeFile(join(root, 'config.yaml'), `${secretName}: generated-extra-path-value`, 'utf8');

    const result = await scanFiles(scanPathsForCli(['--', root], root), []);

    expect(result.findings).toEqual([{
      file: 'config.yaml',
      categories: ['populated-credential']
    }]);
  });

  it('reports only the requested missing path when the documented pnpm command forwards its separator', async () => {
    const root = await temporaryRoot();
    const missing = join(root, 'missing-extracted-archive');

    const result = await scanFiles(scanPathsForCli(['--', missing], root), []);

    expect(result.findings).toEqual([{
      file: 'missing-extracted-archive',
      categories: ['missing-path']
    }]);
  });

  it('fails closed for an explicitly supplied linked root without following it', async () => {
    const parent = await temporaryRoot();
    const outside = await temporaryRoot();
    const linkedRoot = join(parent, 'linked-root');
    const sensitive = 'generated-linked-root-sensitive-value';
    await writeFile(join(outside, 'outside.txt'), sensitive, 'utf8');
    await symlink(outside, linkedRoot, 'junction');

    const result = await scanFiles([linkedRoot], [sensitive]);

    expect(result).toEqual({
      ok: false,
      scannedFiles: 0,
      findings: [{ file: 'linked-root', categories: ['linked-path'] }]
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('fails closed for a linked entry under a scanned root without following it', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const sensitive = 'generated-nested-link-sensitive-value';
    await writeFile(join(root, 'clean.txt'), 'clean', 'utf8');
    await writeFile(join(outside, 'outside.txt'), sensitive, 'utf8');
    await symlink(outside, join(root, 'nested-link'), 'junction');

    const result = await scanFiles([root], [sensitive]);

    expect(result).toEqual({
      ok: false,
      scannedFiles: 1,
      findings: [{ file: 'nested-link', categories: ['linked-path'] }]
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('decodes UTF-16LE and UTF-16BE BOM text and detects both static and exact sensitive values', async () => {
    const root = await temporaryRoot();
    const secretName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    const value = 'generated-utf16-sensitive-value';
    const text = `${secretName}=${value}`;
    const littleEndian = Buffer.from(text, 'utf16le');
    const bigEndian = Buffer.from(littleEndian);
    for (let index = 0; index < bigEndian.length; index += 2) {
      const first = bigEndian[index];
      bigEndian[index] = bigEndian[index + 1]!;
      bigEndian[index + 1] = first!;
    }
    await writeFile(join(root, 'little.yaml'), Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]));
    await writeFile(join(root, 'big.yaml'), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]));

    const result = await scanFiles([root], [value]);

    expect(result.findings).toEqual([
      { file: 'big.yaml', categories: ['sensitive-value', 'populated-credential'] },
      { file: 'little.yaml', categories: ['sensitive-value', 'populated-credential'] }
    ]);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('fails closed without reading oversized files into memory', async () => {
    const root = await temporaryRoot();
    const oversized = join(root, 'oversized.txt');
    await writeFile(oversized, 'x', 'utf8');
    await truncate(oversized, MAX_SCAN_FILE_BYTES + 1);

    const result = await scanFiles([root], ['not-present']);

    expect(result.findings).toEqual([{ file: 'oversized.txt', categories: ['file-too-large'] }]);
    expect(JSON.stringify(result)).not.toContain('not-present');
  });

  it('does not parse an archive as text and scans its separately extracted tree', async () => {
    const root = await temporaryRoot();
    const secretName = ['AROFLO', 'SECRET', 'KEY'].join('_');
    await writeFile(join(root, 'delivery.zip'), `${secretName}=archive-bytes-must-not-be-parsed`, 'utf8');
    await mkdir(join(root, 'delivery-extracted'), { recursive: true });
    await writeFile(join(root, 'delivery-extracted', 'config.yaml'), `${secretName}: extracted-secret`, 'utf8');

    const result = await scanFiles([root], []);

    expect(result.findings).toEqual([
      { file: join('delivery-extracted', 'config.yaml'), categories: ['populated-credential'] },
      { file: 'delivery.zip', categories: ['unsupported-text'] }
    ]);
  });
});
