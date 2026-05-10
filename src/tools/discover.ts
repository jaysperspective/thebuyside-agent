/**
 * x402.discover — search for x402-priced APIs.
 *
 * Two corpora are queried in parallel:
 *   1. Local seed.json (curated, verified) via the Registry class.
 *   2. External federated indexes (CDP Bazaar, agentic.market, x402watch)
 *      via the Federation class.
 *
 * Results are merged and deduplicated by endpoint URL — local entries win
 * on collision because they're verified. Each returned match carries a
 * `source` field so the agent can weigh trust ('verified' vs an external
 * source id). External federation can be disabled with X402_FEDERATION=off.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Gateway } from '../gateway.js';
import { logger } from '../log.js';
import type { RegistryEntry } from '../registry/types.js';

export function registerDiscover(server: McpServer, gateway: Gateway): void {
  server.registerTool(
    'x402.discover',
    {
      title: 'Discover x402-priced APIs',
      description:
        'Search the registry of x402-priced APIs by free-text query. ' +
        'Queries the local curated registry plus external indexes (CDP ' +
        'Bazaar, agentic.market, x402watch) when federation is enabled. ' +
        'Each match carries a `source` field — `verified` means the entry ' +
        'is in our curated seed; other values are external indexes that ' +
        'have not been independently verified.',
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

      const cap = limit ?? 10;
      const localOnly = gateway.registry.search(query);
      const local = localOnly.map((e) => ({ ...e, source: e.source ?? 'verified' as const }));
      const external = await gateway.federation.search(query);

      const merged = mergeByEndpoint(local, external).slice(0, cap);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                matches: merged.map((e) => ({
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
                  source: e.source,
                })),
                total_in_local_registry: gateway.registry.entries.length,
                external_sources: gateway.federation.config.sources.map((s) => s.id),
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

/**
 * Merge local + external entries, deduplicating by canonical endpoint URL.
 * Local entries (which are `verified`) always win on collision so trust
 * doesn't get diluted by an external index that mirrors the same endpoint.
 * Order: locals first (preserving Registry.search's score order), then
 * external entries in the order their sources fired.
 */
function mergeByEndpoint(
  local: RegistryEntry[],
  external: RegistryEntry[],
): RegistryEntry[] {
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const e of local) {
    const k = canonicalEndpoint(e.endpoint);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  for (const e of external) {
    const k = canonicalEndpoint(e.endpoint);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function canonicalEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url.toLowerCase();
  }
}
