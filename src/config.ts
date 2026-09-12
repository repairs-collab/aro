import { z } from 'zod';

export const AREAS = [
  'tasks',
  'clients',
  'locations',
  'quotes',
  'invoices',
  'schedules',
  'users',
  'assets',
  'inventory'
] as const;

export type Area = (typeof AREAS)[number];

export interface AroFloCredentials {
  uEncoded: string;
  pEncoded: string;
  orgEncoded: string;
  secretKey: string;
  hostIp?: string;
}

export interface AppConfig {
  credentials: AroFloCredentials;
  transport: 'stdio' | 'http';
  writeEnabled: boolean;
  writableAreas: ReadonlySet<Area>;
  financialWritesEnabled: boolean;
  mcpAccessToken?: string;
  bindHost: string;
  allowedHosts: ReadonlySet<string>;
  port: number;
  requestTimeoutMs: number;
}

const CREDENTIAL_VARIABLES = [
  'AROFLO_UENCODED',
  'AROFLO_PENCODED',
  'AROFLO_ORG_ENCODED',
  'AROFLO_SECRET_KEY'
] as const;

const areaNames = new Set<string>(AREAS);
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

const requiredSecret = (name: (typeof CREDENTIAL_VARIABLES)[number]) =>
  z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);

const optionalNonBlankString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional()
);

const exactBoolean = z.unknown().transform((value) => value === 'true');

const bindHost = z.string().trim().min(1, 'MCP_BIND_HOST must not be blank').default('127.0.0.1')
  .transform((value) => value.toLowerCase() === '[::1]' ? '::1' : value.toLowerCase())
  .refine(
    (value) => /^[a-z0-9.-]+$/.test(value) || /^[0-9a-f:]+$/.test(value),
    'MCP_BIND_HOST must be a hostname or IP address without a scheme, path, or port'
  );

const allowedHosts = z.string().default('').transform((value, context) => {
  const hosts = [...new Set(value.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean))];
  const invalid = hosts.some((host) =>
    !(/^[a-z0-9.-]+$/.test(host) || /^\[[0-9a-f:]+\]$/.test(host))
  );
  if (invalid) {
    context.addIssue({ code: 'custom', message: 'MCP_ALLOWED_HOSTS must contain hostnames without schemes, paths, or ports' });
    return z.NEVER;
  }
  return hosts;
});

const envSchema = z
  .object({
    AROFLO_UENCODED: requiredSecret('AROFLO_UENCODED'),
    AROFLO_PENCODED: requiredSecret('AROFLO_PENCODED'),
    AROFLO_ORG_ENCODED: requiredSecret('AROFLO_ORG_ENCODED'),
    AROFLO_SECRET_KEY: requiredSecret('AROFLO_SECRET_KEY'),
    AROFLO_HOST_IP: optionalNonBlankString,
    AROFLO_WRITE_ENABLED: exactBoolean,
    AROFLO_WRITABLE_AREAS: z
      .string()
      .default('')
      .transform((value, context) => {
        const areas = [...new Set(value.split(',').map((area) => area.trim()).filter(Boolean))];
        const unknownAreas = areas.filter((area) => !areaNames.has(area));

        if (unknownAreas.length > 0) {
          context.addIssue({
            code: 'custom',
            message: `Unknown writable areas: ${unknownAreas.join(', ')}`
          });
          return z.NEVER;
        }

        return areas as Area[];
      }),
    AROFLO_FINANCIAL_WRITES_ENABLED: exactBoolean,
    MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
    MCP_ACCESS_TOKEN: optionalNonBlankString,
    MCP_BIND_HOST: bindHost,
    MCP_ALLOWED_HOSTS: allowedHosts,
    PORT: z.preprocess(
      (value) => (value === undefined ? 3000 : Number(value)),
      z.number().int().min(1, 'PORT must be between 1 and 65535').max(65_535, 'PORT must be between 1 and 65535')
    ),
    AROFLO_REQUEST_TIMEOUT_MS: z.preprocess(
      (value) => (value === undefined ? 30_000 : Number(value)),
      z.number().int().positive().max(59_999)
    )
  })
  .refine((config) => config.MCP_TRANSPORT !== 'http' || config.MCP_ACCESS_TOKEN !== undefined, {
    message: 'MCP_ACCESS_TOKEN is required when MCP_TRANSPORT is http',
    path: ['MCP_ACCESS_TOKEN']
  })
  .refine((config) => config.MCP_TRANSPORT !== 'http' ||
    LOOPBACK_BIND_HOSTS.has(config.MCP_BIND_HOST) || config.MCP_ALLOWED_HOSTS.length > 0, {
    message: 'MCP_ALLOWED_HOSTS is required when MCP_BIND_HOST is outside loopback',
    path: ['MCP_ALLOWED_HOSTS']
  });

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const missingCredentials = CREDENTIAL_VARIABLES.filter((name) =>
      result.error.issues.some((issue) => issue.path[0] === name)
    );

    if (missingCredentials.length > 0) {
      throw new Error(`Missing required environment variables: ${missingCredentials.join(', ')}`);
    }

    throw result.error;
  }

  const parsed = result.data;
  const credentials: AroFloCredentials = {
    uEncoded: parsed.AROFLO_UENCODED,
    pEncoded: parsed.AROFLO_PENCODED,
    orgEncoded: parsed.AROFLO_ORG_ENCODED,
    secretKey: parsed.AROFLO_SECRET_KEY,
    ...(parsed.AROFLO_HOST_IP === undefined ? {} : { hostIp: parsed.AROFLO_HOST_IP })
  };

  return {
    credentials,
    transport: parsed.MCP_TRANSPORT,
    writeEnabled: parsed.AROFLO_WRITE_ENABLED,
    writableAreas: new Set(parsed.AROFLO_WRITABLE_AREAS),
    financialWritesEnabled: parsed.AROFLO_FINANCIAL_WRITES_ENABLED,
    ...(parsed.MCP_ACCESS_TOKEN === undefined ? {} : { mcpAccessToken: parsed.MCP_ACCESS_TOKEN }),
    bindHost: parsed.MCP_BIND_HOST,
    allowedHosts: new Set(
      LOOPBACK_BIND_HOSTS.has(parsed.MCP_BIND_HOST) ? LOOPBACK_ALLOWED_HOSTS : parsed.MCP_ALLOWED_HOSTS
    ),
    port: parsed.PORT,
    requestTimeoutMs: parsed.AROFLO_REQUEST_TIMEOUT_MS
  };
}

export function canWriteArea(config: AppConfig, area: Area): boolean {
  if (!config.writeEnabled || !config.writableAreas.has(area)) return false;
  return area !== 'invoices' || config.financialWritesEnabled;
}
