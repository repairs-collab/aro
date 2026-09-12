import { vi, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AroFloClient } from '../../src/aroflo/client.js';
import type { AppConfig } from '../../src/config.js';

const stdioMock = vi.hoisted(() => ({
  onerror: undefined as ((error: Error) => void) | undefined,
  close: vi.fn<() => Promise<void>>(),
  serveStdio: vi.fn()
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: stdioMock.serveStdio
}));

import { runStdio } from '../../src/transports/stdio.js';

const config: AppConfig = {
  credentials: {
    uEncoded: 'fake-user',
    pEncoded: 'fake-password',
    orgEncoded: 'fake-org',
    secretKey: 'transport-fake-secret'
  },
  transport: 'stdio',
  writeEnabled: false,
  writableAreas: new Set(),
  financialWritesEnabled: false,
  port: 3000,
  requestTimeoutMs: 100
};
const dependencies = { config, client: {} as AroFloClient };

function settlesWithin(promise: Promise<void>, milliseconds = 100): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), milliseconds))
  ]);
}

beforeEach(() => {
  stdioMock.onerror = undefined;
  stdioMock.close.mockReset().mockResolvedValue(undefined);
  stdioMock.serveStdio.mockReset().mockImplementation((_factory, options: { onerror?: (error: Error) => void }) => {
    stdioMock.onerror = options.onerror;
    return { close: stdioMock.close };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runStdio transport shutdown', () => {
  it('redacts a transport error and resolves after closing without EOF or a signal', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const running = runStdio(dependencies);

    stdioMock.onerror?.(new Error('transport failed with transport-fake-secret'));
    const settled = await settlesWithin(running);
    if (!settled) process.stdin.emit('end');
    await running;

    expect(settled).toBe(true);
    expect(stdioMock.close).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[REDACTED]'));
    expect(stderr.mock.calls.flat().join('')).not.toContain('transport-fake-secret');
  });

  it('closes only once when error and EOF race and ignores duplicate errors', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const running = runStdio(dependencies);

    stdioMock.onerror?.(new Error('first transport-fake-secret failure'));
    process.stdin.emit('end');
    stdioMock.onerror?.(new Error('duplicate transport-fake-secret failure'));

    expect(await settlesWithin(running)).toBe(true);
    expect(stdioMock.close).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.flat().join('')).not.toContain('transport-fake-secret');
  });

  it('rejects synchronous startup failures without retaining process listeners', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const inputEndListeners = process.stdin.listenerCount('end');
    stdioMock.serveStdio.mockImplementationOnce(() => {
      throw new Error('synchronous transport-fake-secret startup failure');
    });

    await expect(runStdio(dependencies)).rejects.toThrow('synchronous transport-fake-secret startup failure');

    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    expect(process.stdin.listenerCount('end')).toBe(inputEndListeners);
    expect(stdioMock.close).not.toHaveBeenCalled();
  });
});
