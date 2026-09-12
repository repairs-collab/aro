import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { AroFloClient } from '../aroflo/client.js';
import { loadConfig, type AppConfig } from '../config.js';
import { buildMcpServer } from '../mcp/build-server.js';
import { redact } from '../redaction.js';
import type { ToolDependencies } from '../tools/read-tools.js';

const SECRET_ENVIRONMENT_KEYS = [
  'AROFLO_UENCODED',
  'AROFLO_PENCODED',
  'AROFLO_ORG_ENCODED',
  'AROFLO_SECRET_KEY',
  'AROFLO_HOST_IP',
  'MCP_ACCESS_TOKEN'
] as const;

function configSensitiveValues(config: AppConfig): readonly string[] {
  return [
    config.credentials.uEncoded,
    config.credentials.pEncoded,
    config.credentials.orgEncoded,
    config.credentials.secretKey,
    ...(config.credentials.hostIp === undefined ? [] : [config.credentials.hostIp]),
    ...(config.mcpAccessToken === undefined ? [] : [config.mcpAccessToken])
  ];
}

function environmentSensitiveValues(env: NodeJS.ProcessEnv): readonly string[] {
  return SECRET_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = env[key];
    return value === undefined || value.length === 0 ? [] : [value];
  });
}

function safeDiagnostic(error: unknown, sensitiveValues: readonly string[]): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = redact(rawMessage, sensitiveValues);
  const message = typeof redacted === 'string' ? redacted : 'Unexpected connector failure';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1_000);
}

function writeDiagnostic(label: string, error: unknown, sensitiveValues: readonly string[]): void {
  process.stderr.write(`${label}: ${safeDiagnostic(error, sensitiveValues)}\n`);
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

export async function runStdio(dependencies?: ToolDependencies): Promise<void> {
  const config = dependencies?.config ?? loadConfig({ ...process.env, MCP_TRANSPORT: 'stdio' });
  const resolvedDependencies: ToolDependencies = dependencies ?? {
    config,
    client: new AroFloClient({ config })
  };
  const sensitiveValues = configSensitiveValues(config);

  await new Promise<void>((resolveClosed, rejectClosed) => {
    let handle: StdioServerHandle | undefined;
    let closePending = false;
    let closeStarted = false;

    const cleanup = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.stdin.off('end', onInputEnd);
    };
    const close = () => {
      if (closeStarted) return;
      if (handle === undefined) {
        closePending = true;
        return;
      }
      closeStarted = true;
      void handle.close()
        .catch((error: unknown) => writeDiagnostic('AroFlo connector shutdown error', error, sensitiveValues))
        .finally(() => {
          cleanup();
          resolveClosed();
        });
    };
    const onSignal = () => {
      process.exitCode = 0;
      close();
    };
    const onInputEnd = () => close();

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.stdin.once('end', onInputEnd);
    try {
      handle = serveStdio(() => buildMcpServer(resolvedDependencies), {
        onerror: (error) => {
          writeDiagnostic('AroFlo connector transport error', error, sensitiveValues);
          close();
        }
      });
      if (closePending) close();
    } catch (error) {
      cleanup();
      rejectClosed(error);
    }
  });
}

if (isEntrypoint()) {
  try {
    await runStdio();
  } catch (error) {
    writeDiagnostic('AroFlo connector failed', error, environmentSensitiveValues(process.env));
    process.exitCode = 1;
  }
}
