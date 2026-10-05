import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TrackerHttpClient, scratchConnection } from '../http-client.js';
import { ReadTools } from '../tools/read-tools.js';
import { createMcpServer } from './server.js';

try {
  const origin = scratchConnection(process.env);
  const server = createMcpServer(new ReadTools(new TrackerHttpClient(origin)));
  await server.connect(new StdioServerTransport());
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
} catch {
  console.error(
    'Lifebot MCP could not start. Configure an explicit loopback LIFEBOT_TRACKER_URL and LIFEBOT_SCRATCH_ONLY=true for a scratch deployment.',
  );
  process.exitCode = 1;
}
