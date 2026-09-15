import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('local Windows launcher', () => {
  it('uses the portable Node lookup order and keeps diagnostics off stdout', async () => {
    const script = await readFile('scripts/start-local.ps1', 'utf8');
    const explicitNode = script.indexOf('$env:AROFLO_NODE_PATH');
    const commandNode = script.indexOf('Get-Command node');
    const bundledNode = script.indexOf("Join-Path $env:USERPROFILE '.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe'");

    expect(explicitNode).toBeGreaterThanOrEqual(0);
    expect(commandNode).toBeGreaterThan(explicitNode);
    expect(bundledNode).toBeGreaterThan(commandNode);
    expect(script).toContain("Resolve-Path (Join-Path $PSScriptRoot '..')");
    expect(script).toContain("Join-Path $pluginRoot 'dist\\src\\transports\\stdio.js'");
    expect(script).toContain('[Console]::Error.WriteLine');
    expect(script).toContain('Test-Path -LiteralPath $nodePath -PathType Leaf');
    expect(script).not.toMatch(/Write-Output|Write-Host/);
    expect(script).not.toMatch(/[A-Z]:\\Users\\/i);
  });

  it('rejects a directory-valued explicit Node path with the controlled diagnostic', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aroflo-node-directory-'));
    temporaryDirectories.push(directory);
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/start-local.ps1'
    ], {
      cwd: process.cwd(),
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        AROFLO_NODE_PATH: directory
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('A Node.js 20+ runtime was not found');
  });

  it('declares a credential-free relative launcher command for Codex', async () => {
    const manifest = JSON.parse(await readFile('.mcp.json', 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: unknown }>;
    };
    const local = manifest.mcpServers?.['aroflo-connector'];

    expect(local).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        './scripts/start-local.ps1'
      ]
    });
    expect(JSON.stringify(manifest)).not.toMatch(/UENCODED|PENCODED|ORG_ENCODED|SECRET_KEY|ACCESS_TOKEN/);
  });
});
