import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface QueuedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

export interface FakeAroFloServer {
  baseUrl: string;
  requests: RecordedRequest[];
  queue(...responses: QueuedResponse[]): void;
  close(): Promise<void>;
}

export async function startFakeAroFloServer(): Promise<FakeAroFloServer> {
  const requests: RecordedRequest[] = [];
  const responses: QueuedResponse[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      const queued = responses.shift() ?? { status: 500, body: { status: 'ERROR', statusmessage: 'No fake response queued' } };
      const send = () => {
        response.writeHead(queued.status ?? 200, {
          'content-type': 'application/json',
          ...queued.headers
        });
        response.end(queued.rawBody ?? JSON.stringify(queued.body ?? {}));
      };
      if (queued.delayMs === undefined) send();
      else setTimeout(send, queued.delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fake server did not bind');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    queue: (...queued) => responses.push(...queued),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  };
}
