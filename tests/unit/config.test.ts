import { describe, expect, it } from 'vitest';
import { canWriteArea, loadConfig } from '../../src/config.js';

const base = {
  AROFLO_UENCODED: 'fake-user',
  AROFLO_PENCODED: 'fake-key',
  AROFLO_ORG_ENCODED: 'fake-org',
  AROFLO_SECRET_KEY: 'fake-secret'
};

describe('loadConfig', () => {
  it('rejects each missing credential without including its value', () => {
    for (const name of Object.keys(base)) {
      const env = { ...base } as Record<string, string>;
      delete env[name];

      let error: unknown;
      try {
        loadConfig(env);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(new RegExp(name));
      expect((error as Error).message).not.toMatch(/fake-(?:user|key|org|secret)/);
    }
  });

  it('rejects blank credentials as missing', () => {
    expect(() => loadConfig({ ...base, AROFLO_SECRET_KEY: '   ' })).toThrow(/AROFLO_SECRET_KEY/);
  });

  it('fails closed and applies cumulative write gates', () => {
    const off = loadConfig(base);
    expect(canWriteArea(off, 'tasks')).toBe(false);

    const tasksOnly = loadConfig({
      ...base,
      AROFLO_WRITE_ENABLED: 'true',
      AROFLO_WRITABLE_AREAS: ' tasks, invoices, tasks '
    });
    expect(tasksOnly.writableAreas).toEqual(new Set(['tasks', 'invoices']));
    expect(canWriteArea(tasksOnly, 'tasks')).toBe(true);
    expect(canWriteArea(tasksOnly, 'invoices')).toBe(false);

    const financial = loadConfig({
      ...base,
      AROFLO_WRITE_ENABLED: 'true',
      AROFLO_WRITABLE_AREAS: 'invoices',
      AROFLO_FINANCIAL_WRITES_ENABLED: 'true'
    });
    expect(canWriteArea(financial, 'invoices')).toBe(true);
  });

  it('treats every write-flag spelling except exact true as false', () => {
    for (const value of [undefined, '', 'TRUE', 'True', ' false', '1']) {
      const config = loadConfig({
        ...base,
        AROFLO_WRITE_ENABLED: value,
        AROFLO_FINANCIAL_WRITES_ENABLED: value,
        AROFLO_WRITABLE_AREAS: 'tasks,invoices'
      });

      expect(config.writeEnabled).toBe(false);
      expect(config.financialWritesEnabled).toBe(false);
      expect(canWriteArea(config, 'tasks')).toBe(false);
    }
  });

  it('requires a hosted access token', () => {
    expect(() => loadConfig({ ...base, MCP_TRANSPORT: 'http' })).toThrow(/MCP_ACCESS_TOKEN/);
    expect(loadConfig({ ...base, MCP_TRANSPORT: 'stdio' }).transport).toBe('stdio');
    expect(loadConfig({ ...base, MCP_TRANSPORT: 'http', MCP_ACCESS_TOKEN: 'fake-token' }).mcpAccessToken).toBe(
      'fake-token'
    );
  });

  it('rejects unknown writable areas and invalid ports', () => {
    expect(() => loadConfig({ ...base, AROFLO_WRITABLE_AREAS: 'tasks,unknown' })).toThrow(/unknown/);
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: '65536' })).toThrow(/PORT/);
  });
});
