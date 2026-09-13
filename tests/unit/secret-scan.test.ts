import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanFiles } from '../../scripts/secret-scan.js';

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

  it('flags real dotenv files while allowing the blank example and skips .git, node_modules, binaries, and symlinks', async () => {
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

    expect(result.findings).toEqual([{ file: '.env.local', categories: ['dotenv-file'] }]);
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
});
