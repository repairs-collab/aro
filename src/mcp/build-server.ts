import type { McpServer } from '@modelcontextprotocol/server';
import { createConnectorServer, registerConnectorTool } from './sdk-adapter.js';
import { createReadToolDefinitions, type ToolDependencies } from '../tools/read-tools.js';

export interface ConnectorServerOptions extends ToolDependencies { name?: string; version?: string; }
export function buildMcpServer(options: ConnectorServerOptions): McpServer { const server = createConnectorServer(); for (const tool of createReadToolDefinitions(options)) registerConnectorTool(server, tool); return server; }
