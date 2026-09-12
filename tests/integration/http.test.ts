import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { request as httpRequest, type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createHttpServer, shutdownHttpServer } from '../../src/transports/http.js';
import { READ_TOOL_NAMES } from '../../src/tools/read-tools.js';

const baseEnvironment = {
  AROFLO_UENCODED: 'fake-user',
  AROFLO_PENCODED: 'fake-password',
  AROFLO_ORG_ENCODED: 'fake-org',
  AROFLO_SECRET_KEY: 'fake-secret',
  AROFLO_WRITE_ENABLED: 'false',
  AROFLO_WRITABLE_AREAS: '',
  AROFLO_FINANCIAL_WRITES_ENABLED: 'false',
  MCP_TRANSPORT: 'http',
  MCP_ACCESS_TOKEN: 'fake-access-token'
} as const;

interface HttpResponse {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}

const servers: import('node:http').Server[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => shutdownHttpServer(server, 250)));
});

async function listen(config: AppConfig): Promise<{ server: import('node:http').Server; port: number }> {
  const server = createHttpServer(config);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function send(
  port: number,
  path: string,
  options: RequestOptions & { chunks?: readonly (string | Buffer)[] } = {}
): Promise<HttpResponse> {
  const chunks = options.chunks ?? [];
  return new Promise<HttpResponse>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers
    }, (response) => {
      const body: Buffer[] = [];
      response.on('data', (chunk: Buffer) => body.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(body).toString('utf8')
      }));
    });
    request.once('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

describe('hosted configuration', () => {
  it('uses loopback-only defaults and a default port', () => {
    const config = loadConfig(baseEnvironment);

    expect(config.bindHost).toBe('127.0.0.1');
    expect(config.allowedHosts).toEqual(new Set(['localhost', '127.0.0.1', '[::1]']));
    expect(config.port).toBe(3000);
  });

  it('fails closed for a public bind without an explicit Host allowlist', () => {
    expect(() => loadConfig({ ...baseEnvironment, MCP_BIND_HOST: '0.0.0.0' })).toThrow(/MCP_ALLOWED_HOSTS/);
  });

  it('rejects a bind URL instead of treating it as a network host', () => {
    expect(() => loadConfig({
      ...baseEnvironment,
      MCP_BIND_HOST: 'https://mcp.example.test',
      MCP_ALLOWED_HOSTS: 'mcp.example.test'
    })).toThrow(/MCP_BIND_HOST/);
  });
});

describe('hosted HTTP transport', () => {
  it('returns a Bearer challenge for missing and wrong credentials', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    for (const authorization of [undefined, 'Bearer fake-access-tokee']) {
      const response = await send(port, '/mcp', {
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
          ...(authorization === undefined ? {} : { authorization })
        },
        chunks: [requestBody]
      });

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.body).not.toContain('fake-access-token');
    }
  });

  it('supports tools/list with the correct token and keeps write tools absent', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer fake-access-token' } }
    });
    const client = new Client({ name: 'http-transport-test', version: '1.0.0' });
    clients.push(client);

    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toEqual(READ_TOOL_NAMES);
    expect(names).not.toContain('aroflo_create_record');
    expect(names).not.toContain('aroflo_update_record');
  });

  it('serves a minimal unauthenticated health response and returns 404 elsewhere', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));

    const health = await send(port, '/healthz', { headers: { host: `localhost:${port}` } });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok', version: '0.1.0' });
    expect(Object.keys(JSON.parse(health.body))).toEqual(['status', 'version']);

    const missing = await send(port, '/not-mcp', { headers: { host: `localhost:${port}` } });
    expect(missing.status).toBe(404);
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts the loopback Host value %s', async (host) => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const response = await send(port, '/healthz', { headers: { host: `${host}:${port}` } });

    expect(response.status).toBe(200);
  });

  it('rejects a Host outside the public-bind allowlist before authentication', async () => {
    const config = loadConfig({
      ...baseEnvironment,
      MCP_BIND_HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'mcp.example.test'
    });
    const { port } = await listen(config);
    const response = await send(port, '/mcp', {
      method: 'POST',
      headers: { host: `attacker.example:${port}`, 'content-type': 'application/json' },
      chunks: ['{}']
    });

    expect(response.status).toBe(403);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.body).not.toContain('fake-access-token');
  });

  it('rejects a declared body above 1 MiB before MCP handling', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const response = await send(port, '/mcp', {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: 'Bearer fake-access-token',
        'content-type': 'application/json',
        'content-length': 1_048_577
      }
    });

    expect(response.status).toBe(413);
  });

  it('rejects a chunked body as soon as it grows above 1 MiB', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const response = await send(port, '/mcp', {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: 'Bearer fake-access-token',
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      },
      chunks: [Buffer.alloc(700_000, 0x20), Buffer.alloc(400_000, 0x20)]
    });

    expect(response.status).toBe(413);
  });

  it('bounds shutdown when a client never finishes its request body', async () => {
    const { server, port } = await listen(loadConfig(baseEnvironment));
    const pending = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: 'Bearer fake-access-token',
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      }
    });
    pending.on('error', () => undefined);
    pending.write('{"jsonrpc":');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const started = Date.now();
    await shutdownHttpServer(server, 25);

    expect(Date.now() - started).toBeLessThan(500);
    expect(server.listening).toBe(false);
    pending.destroy();
  });
});
