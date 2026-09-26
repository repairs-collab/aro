import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_TOOL_NAMES } from '../../src/tools/read-tools.js';
import { startFakeAroFloServer } from './fake-aroflo-server.js';

const NODE_PATH = process.execPath;
const temporaryDirectories: string[] = [];

function safeProcessEnvironment(): Record<string, string> {
  const inheritedKeys = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE'] as const;
  return Object.fromEntries(inheritedKeys.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function waitForFile(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      try {
        if (readFileSync(path, 'utf8') === expected) {
          resolve();
          return;
        }
      } catch {
        // The child creates the marker during its clean exit.
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for clean child exit marker at ${path}`));
        return;
      }
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

describe('stdio transport', () => {
  it('serves only the six read tools over protocol-only stdout and exits cleanly', async () => {
    const service = await startFakeAroFloServer();
    const directory = mkdtempSync(join(tmpdir(), 'aroflo-stdio-'));
    temporaryDirectories.push(directory);
    const capturePath = join(directory, 'stdout.ndjson');
    const exitPath = join(directory, 'exit.txt');
    writeFileSync(capturePath, '');

    const harness = `
      import { appendFileSync, writeFileSync } from 'node:fs';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...args) => {
        appendFileSync(process.env.AROFLO_STDOUT_CAPTURE, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return originalWrite(chunk, ...args);
      };
      process.on('exit', (code) => writeFileSync(process.env.AROFLO_EXIT_CAPTURE, String(code ?? 0)));
      const [{ runStdio }, { loadConfig }, { AroFloClient }] = await Promise.all([
        import('./dist/src/transports/stdio.js'),
        import('./dist/src/config.js'),
        import('./dist/src/aroflo/client.js')
      ]);
      const config = loadConfig({ ...process.env, MCP_TRANSPORT: 'stdio' });
      const client = new AroFloClient({ config, baseUrl: process.env.AROFLO_TEST_BASE_URL });
      await runStdio({ config, client });
    `;
    const transport = new StdioClientTransport({
      command: NODE_PATH,
      args: ['--input-type=module', '--eval', harness],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: {
        AROFLO_UENCODED: 'fake-user',
        AROFLO_PENCODED: 'fake-password',
        AROFLO_ORG_ENCODED: 'fake-org',
        AROFLO_SECRET_KEY: 'fake-secret',
        AROFLO_WRITE_ENABLED: 'false',
        AROFLO_WRITABLE_AREAS: 'tasks,invoices',
        AROFLO_FINANCIAL_WRITES_ENABLED: 'false',
        AROFLO_TEST_BASE_URL: service.baseUrl,
        AROFLO_STDOUT_CAPTURE: capturePath,
        AROFLO_EXIT_CAPTURE: exitPath
      }
    });
    const client = new Client({ name: 'stdio-e2e-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      expect(transport.pid).not.toBeNull();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);

      const described = await client.callTool({
        name: 'aroflo_describe_area',
        arguments: { area: 'tasks' }
      });
      expect(described.isError).not.toBe(true);
      expect(described.structuredContent).toMatchObject({
        area: 'tasks',
        zone: 'tasks',
        identifier: 'taskid'
      });
      expect(service.requests).toHaveLength(0);
    } finally {
      await client.close();
      await service.close();
    }

    await waitForFile(exitPath, '0');
    const protocolLines = readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    expect(protocolLines.length).toBeGreaterThan(0);
    expect(protocolLines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([expect.objectContaining({ jsonrpc: '2.0' })])
    );
    expect(protocolLines.every((line) => (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === '2.0')).toBe(true);
  });

  it('keeps startup failures on stderr and redacts configured secret values', async () => {
    const secret = 'fatal-fake-secret';
    const v2Token = 'fatal-fake-v2-token';
    const child = spawn(NODE_PATH, ['--import', 'tsx', 'src/transports/stdio.ts'], {
      cwd: process.cwd(),
      env: {
        ...safeProcessEnvironment(),
        AROFLO_UENCODED: 'fake-user',
        AROFLO_PENCODED: 'fake-password',
        AROFLO_ORG_ENCODED: 'fake-org',
        AROFLO_SECRET_KEY: secret,
        AROFLO_V2_API_TOKEN: v2Token,
        AROFLO_WRITE_ENABLED: 'false',
        AROFLO_WRITABLE_AREAS: v2Token,
        AROFLO_FINANCIAL_WRITES_ENABLED: 'false'
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
    expect(stderr).toContain('[REDACTED]');
    expect(stderr).not.toContain(secret);
    expect(stderr).not.toContain(v2Token);
  });
});
