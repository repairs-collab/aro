import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ConnectorToolResult } from '../tools/result.js';
import type { ToolDependencies } from '../tools/dependencies.js';
import { createReadToolDefinitions } from '../tools/read-tools.js';
import { createV2InvoiceReadToolDefinitions } from '../tools/v2-invoice-read-tools.js';
import { createV2InvoiceWriteToolDefinitions } from '../tools/v2-invoice-write-tools.js';
import { createWriteToolDefinitions } from '../tools/write-tools.js';
import { CONNECTOR_VERSION } from '../metadata.js';

export interface ConnectorToolDefinition { name: string; title: string; description: string; inputSchema: z.ZodType; annotations: ToolAnnotations; execute(input: unknown): Promise<ConnectorToolResult>; }

export interface ConnectorServerIdentity { name?: string; version?: string; }

function identityPart(value: string | undefined, fallback: string, label: 'name' | 'version'): string {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100) throw new Error(`Invalid MCP server ${label}`);
  return normalized;
}

export function createConnectorServer(identity: ConnectorServerIdentity = {}): McpServer {
  return new McpServer({
    name: identityPart(identity.name, 'aroflo-connector', 'name'),
    version: identityPart(identity.version, CONNECTOR_VERSION, 'version')
  }, {
    instructions: 'Use describe before unfamiliar queries. Before either supported invoice write, call its preview tool, show the preview to the user, and execute the matching write tool only with the single-use confirmationId returned by that preview. Invoice delete, archive, send, approve, payment, add-line, and remove-line operations are unsupported. Other writes may be unavailable by policy.'
  });
}

export function registerConnectorTool(server: McpServer, definition: ConnectorToolDefinition): void {
  server.registerTool(definition.name, { title: definition.title, description: definition.description, inputSchema: definition.inputSchema, annotations: definition.annotations }, async (input) => definition.execute(input));
}

export function registerReadTools(server: McpServer, dependencies: ToolDependencies): void {
  for (const tool of createReadToolDefinitions(dependencies)) registerConnectorTool(server, tool);
}

export function registerWriteTools(server: McpServer, dependencies: ToolDependencies): void {
  for (const tool of createWriteToolDefinitions(dependencies)) registerConnectorTool(server, tool);
}

export function registerV2InvoiceReadTools(server: McpServer, dependencies: ToolDependencies): void {
  for (const tool of createV2InvoiceReadToolDefinitions(dependencies)) registerConnectorTool(server, tool);
}

export function registerV2InvoiceWriteTools(server: McpServer, dependencies: ToolDependencies): void {
  for (const tool of createV2InvoiceWriteToolDefinitions(dependencies)) registerConnectorTool(server, tool);
}
