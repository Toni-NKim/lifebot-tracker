import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../../../app/integrations/lifebot/mcp/server.js';
import { ReadTools } from '../../../app/integrations/lifebot/tools/read-tools.js';
import { TrackerHttpClient } from '../../../app/integrations/lifebot/http-client.js';
import { toolNames } from '../../../app/integrations/lifebot/contracts/tools.js';
import path from 'node:path';

it('advertises precisely eight strict versioned read tools and returns structured domain errors', async () => {
  const server = createMcpServer(
    new ReadTools(new TrackerHttpClient('http://127.0.0.1:4317', async () => new Response('{}'))),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  try {
    await server.connect(b);
    await client.connect(a);
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(toolNames);
    for (const tool of list.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema).toBeDefined();
      expect(JSON.stringify(tool.outputSchema)).toContain('schema_version');
    }
    const invalid = await client.callTool({ name: 'get_todos', arguments: { limit: 201 } });
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: { status: 'error', error: { code: 'VALIDATION_ERROR' } },
    });
    const malformed = await client.callTool({ name: 'get_today', arguments: {} });
    expect(malformed).toMatchObject({
      isError: true,
      structuredContent: {
        status: 'error',
        data: null,
        error: { code: 'UPSTREAM_CONTRACT_ERROR' },
      },
    });
    expect(malformed.content).toEqual([
      { type: 'text', text: JSON.stringify(malformed.structuredContent) },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it('launches the actual stdio executable without requiring Tracker storage or an env file', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('app/integrations/lifebot/mcp/main.ts'),
    ],
    env: {
      PATH: process.env.PATH ?? '',
      LIFEBOT_SCRATCH_ONLY: 'true',
      LIFEBOT_TRACKER_URL: 'http://127.0.0.1:4317',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(toolNames);
    const result = await client.callTool({
      name: 'get_history',
      arguments: { domain: 'habit', from: '2026-02-30', to: '2026-03-01' },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(stderr).toBe('');
  } finally {
    await client.close();
  }
});
