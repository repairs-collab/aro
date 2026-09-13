import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SecretFindingCategory =
  | 'sensitive-value'
  | 'populated-credential'
  | 'private-key'
  | 'authorization-header'
  | 'authentication-signature'
  | 'dotenv-file';

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
const SENSITIVE_ENVIRONMENT_KEYS = [
  'AROFLO_UENCODED',
  'AROFLO_PENCODED',
  'AROFLO_ORG_ENCODED',
  'AROFLO_SECRET_KEY',
  'MCP_ACCESS_TOKEN'
] as const;

const credentialAssignment = /\b(?:AROFLO_(?:UENCODED|PENCODED|ORG_ENCODED|SECRET_KEY)|MCP_ACCESS_TOKEN)\b[ \t]*(?:=(?!=)[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#;=]+))|:[ \t]*(?:"([^"]+)"|'([^']+)'))/gi;
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
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

function hasPopulatedCredential(text: string): boolean {
  credentialAssignment.lastIndex = 0;
  for (const match of text.matchAll(credentialAssignment)) {
    const value = match.slice(1).find((candidate) => candidate !== undefined)?.trim();
    if (value !== undefined && value.length > 0 && !isObviousPlaceholder(value)) return true;
  }
  return false;
}

function isObviousPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return /^(?:fake|wrong|private|test|example|placeholder)(?:[-_]|$)/.test(normalized) ||
    normalized === '[redacted]' ||
    (/^[a-z0-9]+$/.test(normalized) && new Set(normalized).size === 1);
}

function hasAuthorizationHeader(text: string): boolean {
  authorizationHeader.lastIndex = 0;
  for (const match of text.matchAll(authorizationHeader)) {
    if (match[1] !== undefined && !isObviousPlaceholder(match[1])) return true;
  }
  return false;
}

function hasAuthenticationSignature(text: string): boolean {
  authenticationSignature.lastIndex = 0;
  for (const match of text.matchAll(authenticationSignature)) {
    const signature = match[1];
    if (signature !== undefined && new Set(signature.toLowerCase()).size >= 4) return true;
  }
  return false;
}

function categoriesFor(path: string, buffer: Buffer, sensitiveValues: readonly string[]): SecretFindingCategory[] {
  const categories: SecretFindingCategory[] = [];
  if (isDotenvFile(path)) categories.push('dotenv-file');
  if (sensitiveValues.some((value) => buffer.includes(Buffer.from(value, 'utf8')))) categories.push('sensitive-value');

  const text = decodeText(buffer);
  if (text === undefined) return categories;
  if (hasPopulatedCredential(text)) categories.push('populated-credential');
  if (privateKeyBlock.test(text)) categories.push('private-key');
  if (hasAuthorizationHeader(text)) categories.push('authorization-header');
  if (hasAuthenticationSignature(text)) categories.push('authentication-signature');
  return categories;
}

async function walk(root: string): Promise<{ rootIsFile: boolean; files: string[] }> {
  const absoluteRoot = resolve(root);
  let rootStatus;
  try {
    rootStatus = await lstat(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rootIsFile: false, files: [] };
    throw error;
  }
  if (rootStatus.isSymbolicLink()) return { rootIsFile: false, files: [] };
  if (rootStatus.isFile()) return { rootIsFile: true, files: [absoluteRoot] };
  if (!rootStatus.isDirectory()) return { rootIsFile: false, files: [] };

  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const candidate = resolve(directory, entry.name);
      if (!isContained(absoluteRoot, candidate) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(absoluteRoot);
  return { rootIsFile: false, files };
}

export async function scanFiles(paths: readonly string[], sensitiveValues: readonly string[]): Promise<ScanResult> {
  const safeSensitiveValues = [...new Set(sensitiveValues.filter((value) => value.trim().length > 0))];
  const findings: SecretFinding[] = [];
  const scanned = new Set<string>();

  for (const requestedPath of paths) {
    const absoluteRoot = resolve(requestedPath);
    const { rootIsFile, files } = await walk(absoluteRoot);
    for (const file of files.sort()) {
      if (scanned.has(file)) continue;
      scanned.add(file);
      const buffer = await readFile(file);
      const categories = categoriesFor(file, buffer, safeSensitiveValues);
      if (categories.length > 0) findings.push({ file: displayPath(absoluteRoot, file, rootIsFile), categories });
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
  const roots = [
    'src',
    'scripts',
    'tests',
    'dist',
    'docs',
    'skills',
    '.codex-plugin',
    '.mcp.json',
    '.env.example',
    'package.json',
    'pnpm-lock.yaml',
    'README.md',
    'DEPLOYMENT.md',
    'Dockerfile',
    'outputs'
  ];
  try {
    const result = await scanFiles(roots, currentSensitiveValues(process.env));
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
