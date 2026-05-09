/**
 * x402.fetch — make an HTTP request to an x402-priced URL, paying if required.
 *
 * M1 stub: returns a canned response without making any network call. The real
 * payment flow lands in M2, where we lift the protocol logic from
 * scripts/pay-newsep.ts into src/x402/client.ts and call it from here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { logger } from '../log.js';

export function registerFetch(server: McpServer, _config: Config): void {
  server.registerTool(
    'x402.fetch',
    {
      title: 'Fetch an x402-priced URL (paying if required)',
      description:
        'Make an HTTP request to an x402-priced URL. If the server returns 402, ' +
        'the gateway signs and submits the required USDC payment from its ' +
        'configured wallet (subject to spend caps and the host allowlist), then ' +
        'returns the response body. The LLM client never sees the wallet or 402.',
      inputSchema: {
        url: z.string().url().describe('Full URL of the x402-priced endpoint'),
        method: z
          .enum(['GET', 'POST'])
          .optional()
          .describe('HTTP method (default GET)'),
      },
    },
    async ({ url, method }) => {
      const m = method ?? 'GET';
      logger.info('fetch called', { url, method: m });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                request: { url, method: m },
                status: 'stub',
                _stub:
                  'M1 stub — no network call, no payment. M2 wires the M0 protocol logic and enforces spend caps + host allowlist.',
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
