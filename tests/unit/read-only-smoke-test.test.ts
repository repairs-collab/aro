import { describe, expect, it, vi } from 'vitest';
import type { AroFloPage } from '../../src/aroflo/client.js';
import { ConnectorError } from '../../src/aroflo/errors.js';
import type { AppConfig } from '../../src/config.js';
import * as smokeTest from '../../scripts/read-only-smoke-test.js';

const { assertReadOnlyEnvironment, runReadOnlySmoke } = smokeTest;
type ReadOnlySmokeDependencies = import('../../scripts/read-only-smoke-test.js').ReadOnlySmokeDependencies;

function fakeConfig(): AppConfig {
  return {
    credentials: {
      uEncoded: 'fake-user',
      pEncoded: 'fake-password',
      orgEncoded: 'fake-org',
      secretKey: 'fake-secret'
    },
    transport: 'stdio',
    writeEnabled: false,
    writableAreas: new Set(),
    financialWritesEnabled: false,
    bindHost: '127.0.0.1',
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
    port: 3000,
    requestTimeoutMs: 100
  };
}

function page(records: readonly unknown[], statusMessage = 'OK'): AroFloPage {
  return {
    records,
    page: 1,
    hasMore: false,
    statusMessage,
    rateBudget: { dailyUsed: 3, dailySoftLimit: 1_900 }
  };
}

describe('read-only AroFlo smoke test', () => {
  it.each([
    { AROFLO_WRITE_ENABLED: 'true' },
    { AROFLO_FINANCIAL_WRITES_ENABLED: 'true' },
    { AROFLO_WRITE_ENABLED: 'true', AROFLO_FINANCIAL_WRITES_ENABLED: 'true' }
  ])('refuses exact true write flags before configuration or client construction', async (env) => {
    const loadConfiguration = vi.fn(() => fakeConfig());
    const createClient = vi.fn();

    await expect(runReadOnlySmoke(env, { loadConfiguration, createClient })).rejects.toThrow(
      'Read-only smoke test refused: disable both write flags and restart.'
    );
    expect(loadConfiguration).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('accepts absent and exact false write flags', () => {
    expect(() => assertReadOnlyEnvironment({})).not.toThrow();
    expect(() => assertReadOnlyEnvironment({
      AROFLO_WRITE_ENABLED: 'false',
      AROFLO_FINANCIAL_WRITES_ENABLED: 'false'
    })).not.toThrow();
  });

  it('runs status, one task, and one client read in that exact order and prints summaries only', async () => {
    const calls: unknown[] = [];
    const client = {
      search: vi.fn(async (input: unknown) => {
        calls.push(input);
        if (calls.length === 1) return page([{ taskid: 'status-private-record' }], 'CONNECTED');
        if (calls.length === 2) return page([{ taskid: 'task-private-record' }]);
        return page([{ clientid: 'client-private-record' }]);
      }),
      get: vi.fn(() => { throw new Error('get must not be called'); }),
      listChanges: vi.fn(() => { throw new Error('listChanges must not be called'); }),
      post: vi.fn(() => { throw new Error('post must not be called'); }),
      create: vi.fn(() => { throw new Error('create must not be called'); }),
      update: vi.fn(() => { throw new Error('update must not be called'); }),
      delete: vi.fn(() => { throw new Error('delete must not be called'); }),
      archive: vi.fn(() => { throw new Error('archive must not be called'); })
    };
    const lines: string[] = [];
    const dependencies: ReadOnlySmokeDependencies = {
      loadConfiguration: vi.fn(() => fakeConfig()),
      createClient: vi.fn(() => client),
      writeLine: (line) => lines.push(line)
    };

    const result = await runReadOnlySmoke({
      AROFLO_WRITE_ENABLED: 'false',
      AROFLO_FINANCIAL_WRITES_ENABLED: 'false'
    }, dependencies);

    expect(calls).toEqual([
      { area: 'tasks', page: 1, pageSize: 1, fresh: true },
      { area: 'tasks', page: 1, pageSize: 1, fresh: true },
      { area: 'clients', page: 1, pageSize: 1, fresh: true }
    ]);
    expect(result).toEqual({ status: 'PASS', connectionStatus: 'connected', taskCount: 1, clientCount: 1 });
    expect(lines).toEqual(['PASS connection=connected tasks=1 clients=1']);
    expect(JSON.stringify({ result, lines })).not.toMatch(/private-record|fake-|postxml|authorization/i);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.archive).not.toHaveBeenCalled();
  });

  it('formats controlled sanitized actionable failures with accurate retryability', () => {
    expect(smokeTest).toHaveProperty('formatSmokeFailure');
    const formatter = (smokeTest as unknown as {
      formatSmokeFailure(error: unknown, env: NodeJS.ProcessEnv): string;
    }).formatSmokeFailure;
    const sensitive = 'generated-smoke-secret';

    const line = formatter(
      new ConnectorError('TIMEOUT', `AroFlo request timed out for ${sensitive}`, true),
      { AROFLO_SECRET_KEY: sensitive }
    );

    expect(line).toBe('FAIL code=TIMEOUT retryable=true message="AroFlo request timed out for [REDACTED]"');
    expect(line).not.toContain(sensitive);
    expect(formatter(new Error('private upstream body'), {})).toBe(
      'FAIL code=UNEXPECTED retryable=false message="Unexpected smoke-test failure."'
    );
  });
});
