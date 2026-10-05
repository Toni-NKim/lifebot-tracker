import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  descriptions,
  inputSchemas,
  outputSchema,
  toolNames,
  type ToolName,
} from '../contracts/tools.js';
import type { ReadTools } from '../tools/read-tools.js';

// Low-level SDK registration preserves strict JSON Schema unions at the root.
export function createMcpServer(tools: ReadTools) {
  const server = new Server(
    { name: 'lifebot-readonly', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description: descriptions[name],
      inputSchema: {
        ...zodToJsonSchema(inputSchemas[name], { $refStrategy: 'none' }),
        type: 'object' as const,
      },
      outputSchema: {
        ...zodToJsonSchema(outputSchema(name), { $refStrategy: 'none' }),
        type: 'object' as const,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!toolNames.includes(request.params.name as ToolName))
      return { isError: true, content: [{ type: 'text', text: 'Unknown read tool.' }] };
    const result = await tools.call(
      request.params.name as ToolName,
      request.params.arguments ?? {},
    );
    return {
      isError: result.status === 'error' || result.status === 'unavailable',
      structuredContent: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });
  return server;
}
