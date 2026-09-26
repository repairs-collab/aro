import { AroFloClient, type AroFloClientOptions } from '../aroflo/client.js';
import { RateLimiter, type RequestBudget } from '../aroflo/rate-limiter.js';
import { AroFloV2Client, type AroFloV2ClientOptions } from '../aroflo-v2/client.js';
import { V2ConfirmationStore } from '../aroflo-v2/confirmation-store.js';
import type { AppConfig } from '../config.js';
import type { ToolDependencies } from '../tools/dependencies.js';

interface CreateToolDependenciesOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  legacyBaseUrl?: string;
  v2BaseUrl?: string;
  requestBudget?: RequestBudget;
}

export function createToolDependencies(
  config: AppConfig,
  options: CreateToolDependenciesOptions = {}
): ToolDependencies {
  const requestBudget = options.requestBudget ?? new RateLimiter({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
  const commonClientOptions = {
    config,
    requestBudget,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  const legacyOptions: AroFloClientOptions = {
    ...commonClientOptions,
    ...(options.legacyBaseUrl === undefined ? {} : { baseUrl: options.legacyBaseUrl })
  };
  const client = new AroFloClient(legacyOptions);

  if (config.v2ApiToken === undefined) return { config, client };

  const v2Options: AroFloV2ClientOptions = {
    ...commonClientOptions,
    ...(options.v2BaseUrl === undefined ? {} : { baseUrl: options.v2BaseUrl })
  };
  const confirmationClock = options.now;
  return {
    config,
    client,
    v2Client: new AroFloV2Client(v2Options),
    v2Confirmations: new V2ConfirmationStore({
      ...(confirmationClock === undefined ? {} : { now: () => confirmationClock().getTime() })
    })
  };
}
