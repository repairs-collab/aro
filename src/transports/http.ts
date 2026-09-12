import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { AroFloClient } from '../aroflo/client.js';
import { loadConfig, normalizeRequestHost, type AppConfig } from '../config.js';
import { buildMcpServer } from '../mcp/build-server.js';
import { redact } from '../redaction.js';

const CONNECTOR_VERSION = '0.1.0';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const REJECTION_CLOSE_DEADLINE_MS = 250;
const SHUTDOWN_DEADLINE_MS = 5_000;
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SECRET_ENVIRONMENT_KEYS = [
  'AROFLO_UENCODED',
  'AROFLO_PENCODED',
  'AROFLO_ORG_ENCODED',
  'AROFLO_SECRET_KEY',
  'AROFLO_HOST_IP',
  'MCP_ACCESS_TOKEN'
] as const;

interface HttpServerState {
  closeMcp: () => Promise<void>;
  shutdown?: Promise<void>;
}

type BodyReadResult =
  | { kind: 'ok'; parsed: unknown }
  | { kind: 'invalid' }
  | { kind: 'oversize' }
  | { kind: 'aborted' };

const serverStates = new WeakMap<Server, HttpServerState>();

export function bearerMatches(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(headerValue.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function declaredBodyLength(request: IncomingMessage): number | undefined {
  const raw = request.headers['content-length'];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  return Number(raw);
}

function closeRejectedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.destroyed || response.writableEnded) {
    request.destroy();
    return;
  }

  let forced = false;
  let fallback: NodeJS.Timeout | undefined;
  const forceClose = () => {
    if (forced) return;
    forced = true;
    if (fallback !== undefined) clearTimeout(fallback);
    if (!request.destroyed) request.destroy();
    if (!response.destroyed && !response.writableEnded) response.destroy();
  };

  response.once('finish', () => setImmediate(forceClose));
  response.once('close', forceClose);
  fallback = setTimeout(forceClose, REJECTION_CLOSE_DEADLINE_MS);
  fallback.unref();

  response.shouldKeepAlive = false;
  request.resume();
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-type': 'application/json; charset=utf-8',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function rejectOversize(request: IncomingMessage, response: ServerResponse): void {
  closeRejectedRequest(request, response, 413, { error: 'Request body too large' });
}

async function readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
  return new Promise<BodyReadResult>((resolveBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      resolveBody(result);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        settle({ kind: 'oversize' });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks, total).toString('utf8');
      if (raw.length === 0) {
        settle({ kind: 'ok', parsed: null });
        return;
      }
      try {
        settle({ kind: 'ok', parsed: JSON.parse(raw) as unknown });
      } catch {
        settle({ kind: 'invalid' });
      }
    };
    const onAborted = () => settle({ kind: 'aborted' });
    const onError = () => settle({ kind: 'aborted' });

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

function requestPath(request: IncomingMessage): string {
  return (request.url ?? '/').split('?', 1)[0] ?? '/';
}

function requestHost(request: IncomingMessage): string | undefined {
  const hostValues: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === 'host' && value !== undefined) hostValues.push(value);
  }
  if (hostValues.length !== 1) return undefined;
  return normalizeRequestHost(hostValues[0]!);
}

export function createHttpServer(config: AppConfig): Server {
  const expectedToken = config.mcpAccessToken;
  if (config.transport !== 'http' || expectedToken === undefined || expectedToken.length === 0) {
    throw new Error('Hosted MCP requires HTTP transport and MCP_ACCESS_TOKEN');
  }
  const loopback = LOOPBACK_BIND_HOSTS.has(config.bindHost);
  if (!loopback && config.allowedHosts.size === 0) {
    throw new Error('MCP_ALLOWED_HOSTS is required when MCP_BIND_HOST is outside loopback');
  }

  const dependencies = { config, client: new AroFloClient({ config }) };
  const mcp = createMcpHandler(() => buildMcpServer(dependencies), {
    legacy: 'stateless'
  });
  const nodeMcp = toNodeHandler(mcp);

  const server = createServer((request, response) => {
    void (async () => {
      const hostname = requestHost(request);
      if (hostname === undefined || !config.allowedHosts.has(hostname)) {
        closeRejectedRequest(request, response, 403, { error: 'Forbidden' });
        return;
      }

      const length = declaredBodyLength(request);
      if (Number.isNaN(length)) {
        closeRejectedRequest(request, response, 400, { error: 'Invalid Content-Length' });
        return;
      }
      if (length !== undefined && length > MAX_REQUEST_BODY_BYTES) {
        rejectOversize(request, response);
        return;
      }

      const path = requestPath(request);
      if (request.method === 'GET' && path === '/healthz') {
        request.resume();
        jsonResponse(response, 200, { status: 'ok', version: CONNECTOR_VERSION });
        return;
      }
      if (path !== '/mcp') {
        closeRejectedRequest(request, response, 404, { error: 'Not found' });
        return;
      }
      if (!bearerMatches(request.headers.authorization, expectedToken)) {
        closeRejectedRequest(request, response, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
        return;
      }

      let parsedBody: unknown;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const result = await readJsonBody(request);
        if (result.kind === 'oversize') {
          rejectOversize(request, response);
          return;
        }
        if (result.kind === 'invalid') {
          closeRejectedRequest(request, response, 400, { error: 'Invalid JSON' });
          return;
        }
        if (result.kind === 'aborted') return;
        parsedBody = result.parsed;
      }

      delete request.headers.authorization;
      await nodeMcp(request as unknown as NodeIncomingMessageLike, response, parsedBody);
    })().catch(() => {
      if (!response.headersSent) jsonResponse(response, 500, { error: 'Internal server error' });
      else if (!response.writableEnded) response.destroy();
    });
  });

  serverStates.set(server, { closeMcp: mcp.close });
  return server;
}

export function shutdownHttpServer(server: Server, deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<void> {
  const state = serverStates.get(server);
  if (state?.shutdown !== undefined) return state.shutdown;
  const boundedDeadline = Number.isFinite(deadlineMs) && deadlineMs >= 0 ? deadlineMs : SHUTDOWN_DEADLINE_MS;

  const shutdown = (async () => {
    let timer: NodeJS.Timeout | undefined;
    let deadlineReached = false;
    const deadline = new Promise<void>((resolveDeadline) => {
      timer = setTimeout(() => {
        deadlineReached = true;
        resolveDeadline();
      }, boundedDeadline);
      timer.unref();
    });
    const serverClosed = new Promise<void>((resolveClosed) => {
      server.close(() => resolveClosed());
      server.closeIdleConnections();
    });

    await Promise.race([serverClosed, deadline]);
    if (deadlineReached) server.closeAllConnections();

    const mcpClosed = (state?.closeMcp() ?? Promise.resolve()).catch(() => undefined);
    await Promise.race([Promise.all([serverClosed, mcpClosed]).then(() => undefined), deadline]);
    if (timer !== undefined) clearTimeout(timer);
  })();

  if (state !== undefined) state.shutdown = shutdown;
  return shutdown;
}

function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv): readonly string[] {
  return SECRET_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = env[key];
    return value === undefined || value.length === 0 ? [] : [value];
  });
}

function safeDiagnostic(error: unknown, sensitiveValues: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redact(raw, sensitiveValues);
  return (typeof redacted === 'string' ? redacted : 'Unexpected connector failure')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1_000);
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

async function runHttp(): Promise<void> {
  const config = loadConfig({ ...process.env, MCP_TRANSPORT: 'http' });
  const server = createHttpServer(config);
  await new Promise<void>((resolveListening, rejectListening) => {
    const onError = (error: Error) => rejectListening(error);
    server.once('error', onError);
    server.listen(config.port, config.bindHost, () => {
      server.off('error', onError);
      resolveListening();
    });
  });

  await new Promise<void>((resolveStopped) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void shutdownHttpServer(server).finally(() => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolveStopped();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (isEntrypoint()) {
  try {
    await runHttp();
  } catch (error) {
    process.stderr.write(`AroFlo connector failed: ${safeDiagnostic(error, sensitiveEnvironmentValues(process.env))}\n`);
    process.exitCode = 1;
  }
}
