/**
 * MCP server boot. Constructs the gateway, registers tools, wires stdio.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildGateway } from './gateway.js';
import { logger } from './log.js';
import { registerDiscover } from './tools/discover.js';
import { registerFetch } from './tools/fetch.js';
import { registerWalletStatus } from './tools/wallet_status.js';

async function loadPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const gateway = await buildGateway(config);
  const version = await loadPackageVersion();

  const server = new McpServer({
    name: 'thebuyside-x402-agent',
    version,
  });

  registerDiscover(server, gateway);
  registerFetch(server, gateway);
  registerWalletStatus(server, gateway);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('thebuyside-x402-agent MCP server ready', {
    evmAddress: gateway.signers.evm?.address ?? null,
    solanaAddress: gateway.signers.svm?.publicKey ?? null,
    chains: gateway.chains.map((c) => c.id),
    allowedHosts: gateway.allowlist.allowedHosts,
    registryEntries: gateway.registry.entries.length,
    tools: ['pay.discover', 'pay.fetch', 'pay.wallet_status'],
  });
}
