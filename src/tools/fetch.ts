/**
 * pay.fetch — make an HTTP request to a paid URL, paying if required.
 *
 * Speaks two protocols transparently:
 *   - x402 v1+v2 (Coinbase / Linux Foundation) — Base/EVM and Solana via the
 *     `EXACT_SCHEME`. Detected when the 402 carries `PAYMENT-REQUIRED`
 *     / `X-PAYMENT` headers or an x402-shaped body.
 *   - MPP (paymentauth.org/draft-solana-charge-00) — RFC 7235
 *     `WWW-Authenticate: Payment ...`. Solana mainnet USDC only in v0.5.0.
 *
 * Strategy: one initial GET, peek at the 402 shape, dispatch to whichever
 * client speaks the seller's protocol. Both clients reuse the same gateway
 * policy hooks (caps, confirm, receipts).
 *
 * Errors (no wallet, allowlist deny, cap exceeded, network fail) are returned
 * as structured JSON to the LLM client rather than thrown.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Gateway } from '../gateway.js';
import { logger } from '../log.js';
import { isMppChallengeHeader } from '../mpp/auth-header.js';
import { payAndFetchMpp } from '../mpp/client.js';
import type { ChargeRequest } from '../mpp/types.js';
import { formatUsdcAtomic } from '../policy/format.js';
import { payAndFetch } from '../x402/client.js';
import type { SolanaUsdcAdapter } from '../chains/solana-usdc.js';

export function registerFetch(server: McpServer, gateway: Gateway): void {
  server.registerTool(
    'pay.fetch',
    {
      title: 'Fetch a paid URL (x402 or MPP), paying if required',
      description:
        'Make an HTTP request to a URL that may require payment. If the server ' +
        "returns 402, the gateway speaks either x402 (Coinbase's spec, Base " +
        'and Solana) or MPP (paymentauth.org draft-solana-charge, Solana only) ' +
        'and signs the required USDC payment from its configured wallet — ' +
        'subject to spend caps and the host allowlist — then returns the ' +
        'response body. The LLM client never sees the wallet or the 402.',
      inputSchema: {
        url: z.string().url().describe('Full URL of the paid endpoint'),
        method: z.enum(['GET', 'POST']).optional().describe('HTTP method (default GET)'),
      },
    },
    async ({ url, method }) => {
      const m = method ?? 'GET';
      logger.info('pay.fetch called', { url, method: m });

      const allow = gateway.allowlist.check(url);
      if (!allow.ok) return errorResponse(allow.reason);

      if (gateway.signers.evm === null && gateway.signers.svm === null) {
        return errorResponse(
          'no wallet configured — set X402_PAYER_PRIVATE_KEY (EVM) and/or ' +
            'X402_PAYER_SOLANA_KEY (Solana) in .env, then restart the gateway',
        );
      }

      try {
        const r1 = await fetch(url, { method: m });
        if (r1.status !== 402) {
          return jsonResponse({
            status: r1.status,
            paid: false,
            body: await tryJson(r1),
          });
        }

        const wwwAuth = r1.headers.get('www-authenticate');
        if (isMppChallengeHeader(wwwAuth)) {
          if (gateway.signers.svm === null) {
            return errorResponse(
              'seller returned an MPP challenge (Solana) but no Solana signer ' +
                'is configured — set X402_PAYER_SOLANA_KEY in .env.',
            );
          }
          const adapter = gateway.chains.find((c) => c.kind === 'svm') as
            | SolanaUsdcAdapter
            | undefined;
          if (!adapter) {
            return errorResponse('no Solana chain adapter registered in the gateway');
          }

          const result = await payAndFetchMpp({
            url,
            method: m,
            signer: gateway.signers.svm,
            adapter,
            prefetchedResponse: r1,
            beforePay: async (charge) => {
              const amountAtomic = BigInt(charge.amount);
              const capDecision = await gateway.caps.check(amountAtomic);
              if (!capDecision.ok) throw new Error(capDecision.reason);

              const confirmDecision = await gateway.confirm.ask(server, {
                amountAtomic,
                host: new URL(url).hostname,
                method: m,
                url,
                todaySpentAtomic: await gateway.caps.spentTodayAtomic(),
                dailyCapAtomic: gateway.caps.config.dailyLimitAtomic,
                extensions: mppConfirmExtensions(charge),
              });
              if (!confirmDecision.ok) throw new Error(confirmDecision.reason);
            },
            onPaid: async ({ charge, tx }) => {
              await gateway.receipts.record({
                host: new URL(url).hostname,
                url,
                method: m,
                amount_atomic: charge.amount,
                asset: 'USDC',
                chain: 'solana',
                tx_hash: tx ?? null,
              });
            },
          });

          const out: Record<string, unknown> = {
            status: result.status,
            paid: result.paid,
            protocol: 'mpp',
            body: result.body,
          };
          if (result.paid && result.paidCharge) {
            out.paid_amount_usdc = formatUsdcAtomic(BigInt(result.paidCharge.amount));
            out.paid_to = result.paidCharge.recipient;
            out.tx_hash = result.settledTx ?? null;
          }
          return jsonResponse(out);
        }

        const result = await payAndFetch({
          url,
          method: m,
          signers: gateway.signers,
          chains: gateway.chains,
          prefetchedResponse: r1,
          beforePay: async (reqs) => {
            const amountAtomic = BigInt(reqs.maxAmountRequired);
            const capDecision = await gateway.caps.check(amountAtomic);
            if (!capDecision.ok) throw new Error(capDecision.reason);

            const confirmDecision = await gateway.confirm.ask(server, {
              amountAtomic,
              host: new URL(url).hostname,
              method: m,
              url,
              todaySpentAtomic: await gateway.caps.spentTodayAtomic(),
              dailyCapAtomic: gateway.caps.config.dailyLimitAtomic,
              extensions: reqs.extensions,
            });
            if (!confirmDecision.ok) throw new Error(confirmDecision.reason);
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
          protocol: 'x402',
          body: result.body,
        };
        if (result.paid && result.paidRequirements) {
          out.paid_amount_usdc = formatUsdcAtomic(
            BigInt(result.paidRequirements.maxAmountRequired),
          );
          out.paid_to = result.paidRequirements.payTo;
          out.tx_hash = result.settledTx ?? null;
        }
        if (!result.paid && result.failureDiagnostics) {
          out.failure_diagnostics = result.failureDiagnostics;
        }
        return jsonResponse(out);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('pay.fetch failed', { url, err: msg });
        return errorResponse(msg);
      }
    },
  );
}

/**
 * Surface MPP-specific fields to the confirm prompt under the same
 * `extensions` slot that x402 uses — so the policy module sees one shape
 * regardless of protocol. Description is the most useful signal for a human
 * reviewing the prompt.
 */
function mppConfirmExtensions(charge: ChargeRequest): Record<string, unknown> | undefined {
  if (!charge.description) return undefined;
  return { mpp: { description: charge.description } };
}

function errorResponse(reason: string) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: reason }, null, 2) },
    ],
  };
}

function jsonResponse(out: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
  };
}

async function tryJson(r: Response): Promise<unknown> {
  const text = await r.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
