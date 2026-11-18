import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFleemServer, createSnapshotReader, loadFleemOptions } from './mcp/fleem';

export async function startFleemServer(): Promise<void> {
  const server = createFleemServer(createSnapshotReader(loadFleemOptions()));
  await server.connect(new StdioServerTransport());
}
