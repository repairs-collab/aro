import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolDependencies } from '../tools/dependencies.js';
import {
  createConnectorServer,
  registerReadTools,
  registerV2InvoiceReadTools,
  registerV2InvoiceWriteTools,
  registerWriteTools
} from './sdk-adapter.js';

export interface ConnectorServerOptions extends ToolDependencies { name?: string; version?: string; }
export function buildMcpServer(options: ConnectorServerOptions): McpServer {
  const server = createConnectorServer(options);
  registerReadTools(server, options);
  registerWriteTools(server, options);
  registerV2InvoiceReadTools(server, options);
  registerV2InvoiceWriteTools(server, options);
  return server;
}
