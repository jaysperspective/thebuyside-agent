/**
 * x402.wallet_status — return wallet address, today's spend, and configured limits.
 *
 * M1: address is real (derived from the configured private key); spend tracking
 * is zeroed out because the receipts log doesn't exist yet — that lands in M2.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from '../config.js';
import { logger } from '../log.js';

export function registerWalletStatus(server: McpServer, config: Config): void {
  server.registerTool(
    'x402.wallet_status',
    {
      title: 'Wallet status',
      description:
        'Return the gateway wallet address, today\'s spend total in USDC, and ' +
        'the configured per-call and per-day spend limits. Use this to surface ' +
        'payment context to the user.',
      inputSchema: {},
    },
    async () => {
      logger.info('wallet_status called');

      const address = config.payerPrivateKey
        ? privateKeyToAccount(config.payerPrivateKey).address
        : null;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                address:
                  address ?? '(no wallet configured — set X402_PAYER_PRIVATE_KEY in .env)',
                chain: 'base',
                currency: 'USDC',
                spent_today_usdc: 0,
                daily_limit_usdc: 1.0,
                per_call_limit_usdc: 0.05,
                _stub:
                  'M1: address is real; spend tracking arrives in M2 with the SQLite receipts log.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
