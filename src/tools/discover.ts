/**
 * x402.discover — search the registry of x402-priced APIs.
 *
 * Reads from `src/registry/seed.json` via the Registry class. Lowercase
 * substring match across name + description + tags + category, scored by
 * count of matched query terms. Empty query returns the full list.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Gateway } from '../gateway.js';
import { logger } from '../log.js';

export function registerDiscover(server: McpServer, gateway: Gateway): void {
  server.registerTool(
    'x402.discover',
    {
      title: 'Discover x402-priced APIs',
      description:
        'Search the registry of x402-priced APIs by free-text query. ' +
        'Returns matching endpoints with their per-call price in USDC. ' +
        'Use this before x402.fetch to find APIs that can answer a question.',
      inputSchema: {
        query: z
          .string()
          .describe(
            'Free-text search (e.g. "houston news", "weather", "stock prices"). ' +
              'Empty string returns the full list.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max number of matches to return (default 10).'),
      },
    },
    async ({ query, limit }) => {
      logger.info('discover called', { query, limit });

      const matches = gateway.registry.search(query, { limit });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                matches: matches.map((e) => ({
                  id: e.id,
                  name: e.name,
                  description: e.description,
                  endpoint: e.endpoint,
                  method: e.method,
                  price_usdc: e.price_usdc,
                  chain: e.chain,
                  category: e.category,
                  tags: e.tags,
                  example: e.example,
                  verified: e.verified,
                })),
                total_in_registry: gateway.registry.entries.length,
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
