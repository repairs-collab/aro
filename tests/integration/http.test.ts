import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLikeMcpHandler, NodeMcpRequestHandler, ToNodeHandlerOptions } from '@modelcontextprotocol/node';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { createConnection, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { bearerMatches, createHttpServer, shutdownHttpServer } from '../../src/transports/http.js';
import { READ_TOOL_NAMES } from '../../src/tools/read-tools.js';

const mcpDispatches = vi.hoisted(() => vi.fn());
const NODE_PATH = process.execPath;

vi.mock('@modelcontextprotocol/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/node')>();
  return {
    ...actual,
    toNodeHandler: (handler: FetchLikeMcpHandler, options?: ToNodeHandlerOptions): NodeMcpRequestHandler => {
      const actualHandler = actual.toNodeHandler(handler, options);
      return async (request, response, parsedBody) => {
        mcpDispatches();
        return parsedBody === undefined
          ? actualHandler(request, response)
          : actualHandler(request, response, parsedBody);
      };
    }
  };
});

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

function safeProcessEnvironment(): Record<string, string> {
  const inheritedKeys = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE'] as const;
  return Object.fromEntries(inheritedKeys.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

interface HttpResponse {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}

interface RawHttpResponse {
  response: string;
  elapsedMs: number;
}

const servers: import('node:http').Server[] = [];
const clients: Client[] = [];

beforeEach(() => {
  mcpDispatches.mockClear();
});

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

function sendRawAndWaitForClose(port: number, request: string, timeoutMs = 1_500): Promise<RawHttpResponse> {
  return new Promise<RawHttpResponse>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let settled = false;
    let socketError: Error | undefined;
    const timeout = setTimeout(() => {
      finish(new Error(`Raw HTTP connection did not close within ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve({ response: Buffer.concat(chunks).toString('utf8'), elapsedMs: Date.now() - startedAt });
    };

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (error) => {
      socketError = error;
    });
    socket.once('connect', () => socket.write(request));
    socket.once('close', () => {
      finish(chunks.length === 0 && socketError !== undefined ? socketError : undefined);
    });
  });
}

function waitForAbortedOrErroredRequest(
  server: import('node:http').Server,
  timeoutMs = 1_000
): Promise<'aborted' | 'error'> {
  return new Promise<'aborted' | 'error'>((resolve, reject) => {
    let observedRequest: IncomingMessage | undefined;
    const onAborted = () => finish('aborted');
    const onError = () => finish('error');
    const onRequest = (request: IncomingMessage) => {
      observedRequest = request;
      request.once('aborted', onAborted);
      request.once('error', onError);
    };
    const timeout = setTimeout(() => {
      server.off('request', onRequest);
      reject(new Error(`Server did not observe an aborted or errored stream within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (event: 'aborted' | 'error') => {
      clearTimeout(timeout);
      if (observedRequest !== undefined) {
        observedRequest.off('aborted', onAborted);
        observedRequest.off('error', onError);
      }
      resolve(event);
    };

    server.once('request', onRequest);
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
  it('retains exact bearer-token matching for equal, unequal, and different-length values', () => {
    expect(bearerMatches('Bearer fake-access-token', 'fake-access-token')).toBe(true);
    expect(bearerMatches('Bearer fake-access-tokee', 'fake-access-token')).toBe(false);
    expect(bearerMatches('Bearer short', 'fake-access-token')).toBe(false);
  });

  it('redacts the v2 token from startup errors', async () => {
    const v2Token = 'fatal-fake-v2-token';
    const child = spawn(NODE_PATH, ['--import', 'tsx', 'src/transports/http.ts'], {
      cwd: process.cwd(),
      env: {
        ...safeProcessEnvironment(),
        AROFLO_UENCODED: 'fake-user',
        AROFLO_PENCODED: 'fake-password',
        AROFLO_ORG_ENCODED: 'fake-org',
        AROFLO_SECRET_KEY: 'fake-secret',
        AROFLO_V2_API_TOKEN: v2Token,
        AROFLO_WRITE_ENABLED: 'false',
        AROFLO_WRITABLE_AREAS: v2Token,
        AROFLO_FINANCIAL_WRITES_ENABLED: 'false',
        MCP_TRANSPORT: 'http',
        MCP_ACCESS_TOKEN: 'fake-access-token'
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
    expect(stderr).not.toContain(v2Token);
  });

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

  it('enforces the loopback Host allowlist for a direct AppConfig input', async () => {
    const config: AppConfig = {
      ...loadConfig(baseEnvironment),
      bindHost: '127.0.0.1',
      allowedHosts: new Set(['attacker.example'])
    };
    const { port } = await listen(config);

    for (const host of ['LOCALHOST.', '0x7f000001', '[0:0:0:0:0:0:0:1]']) {
      const response = await send(port, '/healthz', { headers: { host: `${host}:${port}` } });
      expect(response.status).toBe(200);
    }

    const attacker = await send(port, '/healthz', { headers: { host: `attacker.example:${port}` } });
    expect(attacker.status).toBe(403);
    expect(mcpDispatches).not.toHaveBeenCalled();
  });

  it.each(['127.1', '0x7f000001', 'localhost.'])
  ('enforces the loopback Host allowlist for direct bind alias %s', async (bindHost) => {
    const config: AppConfig = {
      ...loadConfig(baseEnvironment),
      bindHost,
      allowedHosts: new Set(['attacker.example'])
    };
    const { port } = await listen(config);

    const loopback = await send(port, '/healthz', { headers: { host: `127.0.0.1:${port}` } });
    const attacker = await send(port, '/healthz', { headers: { host: `attacker.example:${port}` } });

    expect(loopback.status).toBe(200);
    expect(attacker.status).toBe(403);
    expect(mcpDispatches).not.toHaveBeenCalled();
  });

  it('fails closed for an invalid direct AppConfig bind host', () => {
    const config: AppConfig = {
      ...loadConfig(baseEnvironment),
      bindHost: 'https://attacker.example',
      allowedHosts: new Set(['attacker.example'])
    };

    expect(() => createHttpServer(config)).toThrow(/MCP_BIND_HOST/);
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

  it('does not dispatch rejected Host, bearer, or unknown-route requests to MCP', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const cases = [
      {
        path: '/mcp',
        headers: { host: `attacker.example:${port}` },
        expectedStatus: 403
      },
      {
        path: '/mcp',
        headers: { host: `127.0.0.1:${port}`, authorization: 'Bearer wrong-access-token' },
        expectedStatus: 401
      },
      {
        path: '/not-mcp',
        headers: { host: `127.0.0.1:${port}` },
        expectedStatus: 404
      }
    ] as const;

    for (const testCase of cases) {
      const response = await send(port, testCase.path, { headers: testCase.headers });
      expect(response.status).toBe(testCase.expectedStatus);
    }

    expect(mcpDispatches).not.toHaveBeenCalled();
  });

  it('compares request Hosts using canonical case, trailing-dot, IPv4, and IPv6 forms', async () => {
    const config = loadConfig({
      ...baseEnvironment,
      MCP_BIND_HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'example.test,127.0.0.1,[::1]'
    });
    const { port } = await listen(config);

    for (const host of ['EXAMPLE.TEST.', '0x7f000001', '[0:0:0:0:0:0:0:1]']) {
      const response = await send(port, '/healthz', { headers: { host: `${host}:${port}` } });
      expect(response.status).toBe(200);
    }
  });

  it('rejects duplicate and malformed Host headers before authentication and MCP handling', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const cases = [
      [
        'duplicate Host headers',
        `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`
      ],
      [
        'a Host containing a scheme',
        `GET /healthz HTTP/1.1\r\nHost: https://127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
      ],
      [
        'a Host containing an empty DNS label',
        `GET /healthz HTTP/1.1\r\nHost: 127..0.0.1:${port}\r\nConnection: close\r\n\r\n`
      ]
    ] as const;

    for (const [_label, request] of cases) {
      const result = await sendRawAndWaitForClose(port, request);
      expect(result.response).toMatch(/^HTTP\/1\.1 403 /);
      expect(result.response).toMatch(/\r\nconnection: close\r\n/i);
    }
  });

  it.each([
    [
      'a rejected Host',
      403,
      (port: number) =>
        `POST /mcp HTTP/1.1\r\nHost: attacker.example:${port}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\n{\r\n`
    ],
    [
      'a rejected bearer token',
      401,
      (port: number) =>
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer wrong-access-token\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\n{\r\n`
    ],
    [
      'an unknown route',
      404,
      (port: number) =>
        `POST /not-mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\n{\r\n`
    ]
  ])('closes an unterminated chunked body after responding to %s', async (_label, expectedStatus, requestForPort) => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const result = await sendRawAndWaitForClose(port, requestForPort(port));

    expect(result.elapsedMs).toBeLessThan(1_500);
    expect(result.response).toMatch(new RegExp(`^HTTP/1\\.1 ${expectedStatus} `));
    expect(result.response).toMatch(/\r\nconnection: close\r\n/i);
    expect(result.response).not.toContain('fake-access-token');
  });

  it('returns the minimal health body and closes an unterminated chunked health request', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const result = await sendRawAndWaitForClose(
      port,
      `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\n{\r\n`
    );

    expect(result.elapsedMs).toBeLessThan(1_500);
    expect(result.response).toMatch(/^HTTP\/1\.1 200 /);
    expect(result.response).toMatch(/\r\nconnection: close\r\n/i);
    expect(result.response).toContain('{"status":"ok","version":"0.1.0"}');
    expect(result.response).not.toContain('fake-access-token');
    expect(mcpDispatches).not.toHaveBeenCalled();
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

  it('keeps parser-rejected framing errors out of the MCP route', async () => {
    const { port } = await listen(loadConfig(baseEnvironment));
    const cases = [
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: invalid\r\nConnection: close\r\n\r\n`,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{}`
    ];

    for (const request of cases) {
      const result = await sendRawAndWaitForClose(port, request);
      expect(result.response).toMatch(/^HTTP\/1\.1 400 /);
      expect(result.response).toMatch(/\r\nconnection: close\r\n/i);
    }
  });

  it('leaves the server available after an authenticated request stream aborts or errors before dispatch', async () => {
    const { server, port } = await listen(loadConfig(baseEnvironment));
    const serverStreamEvent = waitForAbortedOrErroredRequest(server);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection({ host: '127.0.0.1', port });
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', reject);
    });
    socket.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer fake-access-token\r\n` +
        'Content-Type: application/json\r\nContent-Length: 20\r\n\r\n{'
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    socket.destroy();
    const streamEvent = await serverStreamEvent;
    await closed;

    const health = await send(port, '/healthz', { headers: { host: `127.0.0.1:${port}` } });
    expect(['aborted', 'error']).toContain(streamEvent);
    expect(mcpDispatches).not.toHaveBeenCalled();
    expect(health.status).toBe(200);
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
