import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AroFloClient, type AroFloPage } from '../src/aroflo/client.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { ConnectorError } from '../src/aroflo/errors.js';

interface ReadOnlyClient {
  search(input: {
    area: 'tasks' | 'clients';
    page: number;
    pageSize: number;
    fresh: true;
  }): Promise<AroFloPage>;
}

export interface SmokeResult {
  status: 'PASS';
  connectionStatus: 'connected';
  taskCount: number;
  clientCount: number;
}

export interface ReadOnlySmokeDependencies {
  loadConfiguration?: (env: NodeJS.ProcessEnv) => AppConfig;
  createClient?: (config: AppConfig) => ReadOnlyClient;
  writeLine?: (line: string) => void;
}

export function assertReadOnlyEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.AROFLO_WRITE_ENABLED === 'true' || env.AROFLO_FINANCIAL_WRITES_ENABLED === 'true') {
    throw new Error('Read-only smoke test refused: disable both write flags and restart.');
  }
}

export async function runReadOnlySmoke(
  env: NodeJS.ProcessEnv,
  dependencies: ReadOnlySmokeDependencies = {}
): Promise<SmokeResult> {
  assertReadOnlyEnvironment(env);

  const loadConfiguration = dependencies.loadConfiguration ?? loadConfig;
  const config = loadConfiguration({ ...env, MCP_TRANSPORT: 'stdio' });
  const createClient = dependencies.createClient ?? ((resolvedConfig: AppConfig) =>
    new AroFloClient({ config: resolvedConfig }));
  const client = createClient(config);

  await client.search({ area: 'tasks', page: 1, pageSize: 1, fresh: true });
  const taskPage = await client.search({ area: 'tasks', page: 1, pageSize: 1, fresh: true });
  const clientPage = await client.search({ area: 'clients', page: 1, pageSize: 1, fresh: true });
  const result: SmokeResult = {
    status: 'PASS',
    connectionStatus: 'connected',
    taskCount: taskPage.records.length,
    clientCount: clientPage.records.length
  };

  (dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`)))(
    `PASS connection=${result.connectionStatus} tasks=${result.taskCount} clients=${result.clientCount}`
  );
  return result;
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

function failureCode(error: unknown): string {
  if (error instanceof ConnectorError) return error.code;
  if (error instanceof Error && error.message.startsWith('Read-only smoke test refused:')) return 'WRITE_FLAGS_ENABLED';
  if (error instanceof Error && error.message.startsWith('Missing required environment variables:')) return 'CONFIGURATION';
  return 'UNEXPECTED';
}

if (isEntrypoint()) {
  try {
    await runReadOnlySmoke(process.env);
  } catch (error) {
    process.stderr.write(`FAIL code=${failureCode(error)}\n`);
    process.exitCode = 1;
  }
}
