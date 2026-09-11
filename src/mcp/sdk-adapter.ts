import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ConnectorToolResult } from '../tools/result.js';

export interface ConnectorToolDefinition { name: string; title: string; description: string; inputSchema: z.ZodType; annotations: ToolAnnotations; execute(input: unknown): Promise<ConnectorToolResult>; }

export function createConnectorServer(): McpServer {
  return new McpServer({ name: 'aroflo-connector', version: '0.1.0' }, { instructions: 'Use describe before unfamiliar queries. Preview every proposed change. Writes may be unavailable by policy.' });
}

export function registerConnectorTool(server: McpServer, definition: ConnectorToolDefinition): void {
  server.registerTool(definition.name, { title: definition.title, description: definition.description, inputSchema: definition.inputSchema, annotations: definition.annotations }, async (input) => definition.execute(input));
}
