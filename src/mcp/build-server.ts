import type { McpServer } from '@modelcontextprotocol/server';
import { createConnectorServer, registerReadTools, registerWriteTools } from './sdk-adapter.js';
import type { ToolDependencies } from '../tools/read-tools.js';

export interface ConnectorServerOptions extends ToolDependencies { name?: string; version?: string; }
export function buildMcpServer(options: ConnectorServerOptions): McpServer {
  const server = createConnectorServer(options);
  registerReadTools(server, options);
  registerWriteTools(server, options);
  return server;
}
