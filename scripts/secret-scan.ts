import { lstat, readFile, readdir } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SecretFindingCategory =
  | 'sensitive-value'
  | 'populated-credential'
  | 'private-key'
  | 'authorization-header'
  | 'authentication-signature'
  | 'dotenv-file'
  | 'missing-path'
  | 'unsupported-text'
  | 'file-too-large';

export interface SecretFinding {
  file: string;
  categories: SecretFindingCategory[];
}

export interface ScanResult {
  ok: boolean;
  scannedFiles: number;
  findings: SecretFinding[];
}

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip']);
export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const SENSITIVE_ENVIRONMENT_KEYS = [
  'AROFLO_UENCODED',
  'AROFLO_PENCODED',
  'AROFLO_ORG_ENCODED',
  'AROFLO_SECRET_KEY',
  'MCP_ACCESS_TOKEN'
] as const;

export const DEFAULT_SCAN_PATHS = Object.freeze([
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
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'README.md',
  'DEPLOYMENT.md',
  'Dockerfile'
] as const);

export function scanPathsForCli(additionalPaths: readonly string[]): readonly string[] {
  return [...DEFAULT_SCAN_PATHS, ...additionalPaths];
}

const CREDENTIAL_NAME = '(?:AROFLO_(?:UENCODED|PENCODED|ORG_ENCODED|SECRET_KEY)|MCP_ACCESS_TOKEN)';
const credentialEqualsAssignment = new RegExp(
  `\\b${CREDENTIAL_NAME}\\b[ \\t]*=(?!=)[ \\t]*(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([^\\s#;=]+))`,
  'gi'
);
const quotedStructuredCredential = new RegExp(
  `["']${CREDENTIAL_NAME}["'][ \\t]*:[ \\t]*(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)')`,
  'gi'
);
const yamlCredential = new RegExp(
  `^[ \\t]*(?:["']${CREDENTIAL_NAME}["']|${CREDENTIAL_NAME})[ \\t]*:[ \\t]*(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([^#\\r\\n]+?))[ \\t]*(?:#.*)?$`,
  'gim'
);
const privateKeyBlock = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/i;
const authorizationHeader = /\bauthorization\b["']?\s*[:=]\s*["']?(?:bearer|basic|hmac)\s+([a-z0-9+/_=.-]+)/gi;
const authenticationSignature = /\bauthentication\b["']?\s*[:=]\s*["']?(?:hmac\s+)?([a-f0-9]{32,})/gi;

function isDotenvFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name !== '.env.example' && (name === '.env' || name.startsWith('.env.'));
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

function displayPath(root: string, file: string, rootIsFile: boolean): string {
  return rootIsFile ? basename(file) : relative(root, file) || basename(file);
}

function decodeText(buffer: Buffer): string | undefined {
  try {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const encoded = buffer.subarray(2);
      if (encoded.length % 2 !== 0) return undefined;
      const littleEndian = Buffer.allocUnsafe(encoded.length);
      for (let index = 0; index < encoded.length; index += 2) {
        littleEndian[index] = encoded[index + 1]!;
        littleEndian[index + 1] = encoded[index]!;
      }
      return new TextDecoder('utf-16le', { fatal: true }).decode(littleEndian);
    }
    if (buffer.includes(0)) return undefined;
    const utf8 = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
    return new TextDecoder('utf-8', { fatal: true }).decode(utf8);
  } catch {
    return undefined;
  }
}

const EXACT_PLACEHOLDERS = new Set([
  '[redacted]',
  'auth',
  'fake-access-token',
  'fake-key',
  'fake-org',
  'fake-password',
  'fake-placeholder',
  'fake-secret',
  'fake-token',
  'fake-user',
  'private-token',
  'wrong-access-token',
  'a'.repeat(32),
  'a'.repeat(64)
]);

function isExactPlaceholder(value: string): boolean {
  return EXACT_PLACEHOLDERS.has(value.trim().toLowerCase());
}

function hasNonPlaceholderMatch(text: string, expression: RegExp): boolean {
  expression.lastIndex = 0;
  for (const match of text.matchAll(expression)) {
    const value = match.slice(1).find((candidate) => candidate !== undefined)?.trim();
    if (value !== undefined && value.length > 0 && !isExactPlaceholder(value)) return true;
  }
  return false;
}

function hasPopulatedCredential(path: string, text: string): boolean {
  if (hasNonPlaceholderMatch(text, credentialEqualsAssignment)) return true;
  const extension = extname(path).toLowerCase();
  if (extension === '.json' && hasNonPlaceholderMatch(text, quotedStructuredCredential)) return true;
  return ['.yaml', '.yml'].includes(extension) && hasNonPlaceholderMatch(text, yamlCredential);
}

function hasAuthorizationHeader(text: string): boolean {
  authorizationHeader.lastIndex = 0;
  for (const match of text.matchAll(authorizationHeader)) {
    if (match[1] !== undefined && !isExactPlaceholder(match[1])) return true;
  }
  return false;
}

function hasAuthenticationSignature(text: string): boolean {
  authenticationSignature.lastIndex = 0;
  for (const match of text.matchAll(authenticationSignature)) {
    const signature = match[1];
    if (signature !== undefined && !isExactPlaceholder(signature)) return true;
  }
  return false;
}

function categoriesFor(path: string, buffer: Buffer, sensitiveValues: readonly string[]): SecretFindingCategory[] {
  const categories: SecretFindingCategory[] = [];
  if (isDotenvFile(path)) categories.push('dotenv-file');
  const rawSensitiveMatch = sensitiveValues.some((value) => buffer.includes(Buffer.from(value, 'utf8')));
  if (rawSensitiveMatch) categories.push('sensitive-value');

  const text = decodeText(buffer);
  if (text === undefined) return [...categories, 'unsupported-text'];
  if (!rawSensitiveMatch && sensitiveValues.some((value) => text.includes(value))) categories.push('sensitive-value');
  if (hasPopulatedCredential(path, text)) categories.push('populated-credential');
  if (privateKeyBlock.test(text)) categories.push('private-key');
  if (hasAuthorizationHeader(text)) categories.push('authorization-header');
  if (hasAuthenticationSignature(text)) categories.push('authentication-signature');
  return categories;
}

async function walk(root: string): Promise<{
  rootIsFile: boolean;
  files: string[];
  missing: boolean;
  unreadable: string[];
}> {
  const absoluteRoot = resolve(root);
  let rootStatus;
  try {
    rootStatus = await lstat(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rootIsFile: false, files: [], missing: true, unreadable: [] };
    }
    return { rootIsFile: false, files: [], missing: false, unreadable: [absoluteRoot] };
  }
  if (rootStatus.isSymbolicLink()) return { rootIsFile: false, files: [], missing: false, unreadable: [] };
  if (rootStatus.isFile()) return { rootIsFile: true, files: [absoluteRoot], missing: false, unreadable: [] };
  if (!rootStatus.isDirectory()) return { rootIsFile: false, files: [], missing: false, unreadable: [] };

  const files: string[] = [];
  const unreadable: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadable.push(directory);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const candidate = resolve(directory, entry.name);
      if (!isContained(absoluteRoot, candidate) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(absoluteRoot);
  return { rootIsFile: false, files, missing: false, unreadable };
}

export async function scanFiles(paths: readonly string[], sensitiveValues: readonly string[]): Promise<ScanResult> {
  const safeSensitiveValues = [...new Set(sensitiveValues.filter((value) => value.trim().length > 0))];
  const findings: SecretFinding[] = [];
  const scanned = new Set<string>();

  for (const requestedPath of paths) {
    const absoluteRoot = resolve(requestedPath);
    const { rootIsFile, files, missing, unreadable } = await walk(absoluteRoot);
    if (missing) {
      findings.push({ file: basename(absoluteRoot), categories: ['missing-path'] });
      continue;
    }
    for (const path of unreadable) {
      findings.push({ file: displayPath(absoluteRoot, path, rootIsFile), categories: ['unsupported-text'] });
    }
    for (const file of files.sort()) {
      if (scanned.has(file)) continue;
      scanned.add(file);
      const shownFile = displayPath(absoluteRoot, file, rootIsFile);
      if (ARCHIVE_EXTENSIONS.has(extname(file).toLowerCase())) {
        findings.push({ file: shownFile, categories: ['unsupported-text'] });
        continue;
      }
      let fileStatus: Stats;
      try {
        fileStatus = await lstat(file);
      } catch {
        findings.push({ file: shownFile, categories: ['unsupported-text'] });
        continue;
      }
      if (fileStatus.size > MAX_SCAN_FILE_BYTES) {
        findings.push({ file: shownFile, categories: ['file-too-large'] });
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(file);
      } catch {
        findings.push({ file: shownFile, categories: ['unsupported-text'] });
        continue;
      }
      const categories = categoriesFor(file, buffer, safeSensitiveValues);
      if (categories.length > 0) findings.push({ file: shownFile, categories });
    }
  }

  findings.sort((left, right) => left.file.localeCompare(right.file));
  return { ok: findings.length === 0, scannedFiles: scanned.size, findings };
}

function currentSensitiveValues(env: NodeJS.ProcessEnv): readonly string[] {
  return SENSITIVE_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = env[key];
    return value === undefined || value.trim().length === 0 ? [] : [value];
  });
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isEntrypoint()) {
  try {
    const result = await scanFiles(scanPathsForCli(process.argv.slice(2)), currentSensitiveValues(process.env));
    if (result.ok) {
      process.stdout.write(`PASS scanned=${result.scannedFiles}\n`);
    } else {
      for (const finding of result.findings) {
        process.stderr.write(`FAIL file=${finding.file} categories=${finding.categories.join(',')}\n`);
      }
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('FAIL code=SCAN_ERROR\n');
    process.exitCode = 1;
  }
}
