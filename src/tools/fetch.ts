/**
 * x402.fetch — make an HTTP request to an x402-priced URL, paying if required.
 *
 * Wires the gateway end-to-end:
 *   1. Allowlist check (fast-fail before any network call)
 *   2. payAndFetch drives the 402 → sign → 200 loop
 *   3. beforePay hook enforces the spend caps
 *   4. onPaid hook records a receipt
 *
 * Errors (no wallet, allowlist deny, cap exceeded, network fail) are returned
 * as structured JSON to the LLM client rather than thrown — that lets the
 * model understand and explain what went wrong.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Gateway } from '../gateway.js';
import { logger } from '../log.js';
import { formatUsdcAtomic } from '../policy/format.js';
import { payAndFetch } from '../x402/client.js';

export function registerFetch(server: McpServer, gateway: Gateway): void {
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

      // Pre-flight: host must be allowlisted (most fundamental gate;
      // checked before wallet so unallowed URLs fail-fast even on misconfigured installs).
      const allow = gateway.allowlist.check(url);
      if (!allow.ok) {
        return errorResponse(allow.reason);
      }

      // Pre-flight: wallet must exist before we can pay.
      if (!gateway.signer) {
        return errorResponse(
          'no wallet configured — set X402_PAYER_PRIVATE_KEY in .env (and restart the gateway)',
        );
      }

      try {
        const result = await payAndFetch({
          url,
          method: m,
          signer: gateway.signer,
          chains: gateway.chains,
          beforePay: async (reqs) => {
            const decision = await gateway.caps.check(BigInt(reqs.maxAmountRequired));
            if (!decision.ok) throw new Error(decision.reason);
          },
          onPaid: async ({ reqs, tx }) => {
            const adapter = gateway.chains.find((c) => c.matches(reqs.network));
            await gateway.receipts.record({
              host: new URL(url).hostname,
              url,
              method: m,
              amount_atomic: reqs.maxAmountRequired,
              asset: 'USDC',
              chain: adapter?.id ?? reqs.network,
              tx_hash: tx ?? null,
            });
          },
        });

        const out: Record<string, unknown> = {
          status: result.status,
          paid: result.paid,
          body: result.body,
        };
        if (result.paid && result.paidRequirements) {
          out.paid_amount_usdc = formatUsdcAtomic(
            BigInt(result.paidRequirements.maxAmountRequired),
          );
          out.paid_to = result.paidRequirements.payTo;
          out.tx_hash = result.settledTx ?? null;
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('fetch failed', { url, err: msg });
        return errorResponse(msg);
      }
    },
  );
}

function errorResponse(reason: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: reason }, null, 2),
      },
    ],
  };
}
