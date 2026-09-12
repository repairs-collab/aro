import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

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
    expect(script).not.toMatch(/Write-Output|Write-Host/);
    expect(script).not.toMatch(/[A-Z]:\\Users\\/i);
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
