import { describe, expect, it, vi } from 'vitest';
import type { AroFloClient } from '../../src/aroflo/client.js';
import type { AppConfig, Area } from '../../src/config.js';
import { createWriteToolDefinitions } from '../../src/tools/write-tools.js';

function config(writableAreas: readonly Area[] = ['tasks']): AppConfig {
  return {
    credentials: {
      uEncoded: 'fake-user',
      pEncoded: 'fake-password',
      orgEncoded: 'fake-org',
      secretKey: 'fake-secret'
    },
    transport: 'stdio',
    writeEnabled: true,
    writableAreas: new Set(writableAreas),
    financialWritesEnabled: false,
    v2ApiToken: 'fake-v2-token',
    bindHost: '127.0.0.1',
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
    port: 3000,
    requestTimeoutMs: 100
  };
}

function fakeClient() {
  return {
    search: vi.fn(),
    get: vi.fn(),
    listChanges: vi.fn(),
    post: vi.fn()
  };
}

function definition(
  definitions: ReturnType<typeof createWriteToolDefinitions>,
  name: 'aroflo_create_record' | 'aroflo_update_record'
) {
  const found = definitions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing tool definition: ${name}`);
  return found;
}

describe('AroFlo write tools', () => {
  it('compiles a structured create, posts once, and returns only a sanitized receipt', async () => {
    const client = fakeClient();
    client.post.mockResolvedValueOnce({
      taskid: 'task-created',
      message: 'Saved using fake-secret and fake-v2-token',
      raw: '<private-upstream-body />'
    });
    const tool = definition(
      createWriteToolDefinitions({ config: config(), client: client as unknown as AroFloClient }),
      'aroflo_create_record'
    );

    const result = await tool.execute({
      area: 'tasks',
      fields: {
        taskname: 'Fix & inspect',
        'tasktype.tasktypeid': 'type-1',
        'client.clientid': 'client-1',
        'org.orgid': 'org-1'
      }
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      'tasks',
      '<tasks><task><org><orgid>org-1</orgid></org><client><clientid>client-1</clientid></client><tasktype><tasktypeid>type-1</tasktypeid></tasktype><taskname>Fix &amp; inspect</taskname></task></tasks>'
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      operation: 'create',
      area: 'tasks',
      id: 'task-created',
      success: true,
      upstreamMessage: 'Saved using [REDACTED] and [REDACTED]'
    });
    expect(JSON.stringify(result)).not.toMatch(/private-upstream-body|postxml|<tasks>/i);
  });

  it('compiles a structured update, posts once, and prefers the supplied identifier in its receipt', async () => {
    const client = fakeClient();
    client.post.mockResolvedValueOnce({
      taskid: 'unexpected-upstream-id',
      statusmessage: 'Updated fake-password',
      nested: { private: 'upstream body' }
    });
    const tool = definition(
      createWriteToolDefinitions({ config: config(), client: client as unknown as AroFloClient }),
      'aroflo_update_record'
    );

    const result = await tool.execute({
      area: 'tasks',
      id: 'task-1',
      fields: { taskname: 'New name', status: 'Pending' }
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      'tasks',
      '<tasks><task><taskid>task-1</taskid><taskname>New name</taskname><status>Pending</status></task></tasks>'
    );
    expect(result.structuredContent).toEqual({
      operation: 'update',
      area: 'tasks',
      id: 'task-1',
      success: true,
      upstreamMessage: 'Updated [REDACTED]'
    });
    expect(JSON.stringify(result)).not.toMatch(/unexpected-upstream-id|upstream body|postxml|<tasks>/i);
  });

  it('checks the current write policy immediately before posting when invoked directly', async () => {
    const runtimeConfig = config();
    const client = fakeClient();
    const tool = definition(
      createWriteToolDefinitions({ config: runtimeConfig, client: client as unknown as AroFloClient }),
      'aroflo_update_record'
    );
    (runtimeConfig.writableAreas as Set<Area>).clear();

    const result = await tool.execute({ area: 'tasks', id: 'task-1', fields: { status: 'Pending' } });

    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION' } } });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects non-structured and control-shaped inputs before any post', async () => {
    const client = fakeClient();
    const definitions = createWriteToolDefinitions({ config: config(), client: client as unknown as AroFloClient });
    const create = definition(definitions, 'aroflo_create_record');
    const update = definition(definitions, 'aroflo_update_record');

    const results = await Promise.all([
      create.execute({ area: 'tasks', fields: { raw: '<tasks />' } }),
      create.execute({ area: 'tasks', fields: { query: 'zone=tasks' } }),
      create.execute({ area: 'tasks', fields: { postxml: '<tasks />' } }),
      update.execute({ area: 'tasks', id: 'task-1', fields: { delete: true } }),
      update.execute({ area: 'tasks', id: 'task-1', fields: { archive: true } }),
      update.execute({ area: 'tasks', id: 'task-1', fields: { status: 'Pending' }, raw: 'extra' })
    ]);

    expect(results.every((result) => result.isError === true)).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });
});
