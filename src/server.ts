/**
 * MCP server boot. Constructs the server, registers tools, and wires stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { logger } from './log.js';
import { registerDiscover } from './tools/discover.js';
import { registerFetch } from './tools/fetch.js';
import { registerWalletStatus } from './tools/wallet_status.js';

export async function startServer(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: 'thebuyside-agent',
    version: '0.0.1',
  });

  registerDiscover(server, config);
  registerFetch(server, config);
  registerWalletStatus(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('thebuyside-agent MCP server ready', {
    walletConfigured: config.payerPrivateKey !== null,
    tools: ['x402.discover', 'x402.fetch', 'x402.wallet_status'],
  });
}
