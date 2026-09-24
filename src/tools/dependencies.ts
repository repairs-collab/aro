import type { AroFloClient } from '../aroflo/client.js';
import type { AroFloV2Client } from '../aroflo-v2/client.js';
import type { V2ConfirmationStore } from '../aroflo-v2/confirmation-store.js';
import type { AppConfig } from '../config.js';

export interface ToolDependencies {
  config: AppConfig;
  client: AroFloClient;
  v2Client?: AroFloV2Client;
  v2Confirmations?: V2ConfirmationStore;
}
