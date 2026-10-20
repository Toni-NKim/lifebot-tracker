import type { WriteTools } from '../tools/write-tools.js';
import { writeNames, commandInput, resultSchema, type WriteName } from '../contracts/writes.js';
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
export function createMcpServer(tools: ReadTools, writes?: WriteTools) {
  const server = new Server(
    { name: 'lifebot-readonly', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...toolNames.map((name) => ({
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
      ...(writes
        ? writeNames.map((name) => ({
            name,
            description: `Execute an operator-approved, durably frozen ${name} command. Supply its allocated command_id. Reuse the same ID after uncertainty; never allocate a replacement.`,
            inputSchema: {
              ...zodToJsonSchema(commandInput, { $refStrategy: 'none' }),
              type: 'object' as const,
            },
            outputSchema: {
              ...zodToJsonSchema(resultSchema, { $refStrategy: 'none' }),
              type: 'object' as const,
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          }))
        : []),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (writes && writeNames.includes(request.params.name as WriteName)) {
      const result = await writes.call(
        request.params.name as WriteName,
        request.params.arguments ?? {},
      );
      return {
        isError: result.outcome === 'rejected' || result.outcome === 'unknown',
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
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
