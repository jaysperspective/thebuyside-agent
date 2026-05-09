/**
 * x402.discover — search the registry of x402-priced APIs.
 *
 * M1 stub: returns a hardcoded list with news-ep regardless of the query.
 * M3 swaps in `registry/seed.json` lookup with real filtering by query/tags.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { logger } from '../log.js';

export function registerDiscover(server: McpServer, _config: Config): void {
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
          .describe('Free-text search (e.g. "houston news", "weather", "stock prices")'),
      },
    },
    async ({ query }) => {
      logger.info('discover called', { query });

      const stubMatches = [
        {
          id: 'newsep-stories',
          name: 'Executive Producer — local US news search',
          endpoint: 'https://news-ep.com/api/v1/stories',
          method: 'GET',
          price_usdc: 0.005,
          chain: 'base',
          description:
            'Search local news from US metro markets (DC, Houston, Dallas, etc.).',
          example: 'GET https://news-ep.com/api/v1/stories?market=houston&limit=5',
        },
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                matches: stubMatches,
                _stub:
                  'M1 stub — returns the same hardcoded list regardless of query. M3 wires real registry lookup.',
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
