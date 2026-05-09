/**
 * x402 client — drives the full payment loop:
 *   1. Make the request.
 *   2. If the server returns 402, parse the challenge and pick a payment
 *      option that one of our chain adapters can satisfy.
 *   3. Have the chain adapter build the typed-data + authorization payload.
 *   4. Have the signer sign the typed data.
 *   5. Base64-encode the signed payload into an `X-PAYMENT` header.
 *   6. Re-issue the request with the header.
 *   7. Return the final response (and the settle tx hash if the server
 *      emitted `X-PAYMENT-RESPONSE`).
 *
 * No spend-policy enforcement here — that lives in `src/policy/` (M2b) and
 * wraps this function from the `x402.fetch` MCP tool.
 */

import type { ChainAdapter } from '../chains/adapter.js';
import { logger } from '../log.js';
import type { Signer } from '../signer/signer.js';
import type { Challenge, PaymentPayload, PaymentRequirements } from './types.js';

export type PayAndFetchOptions = {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signer: Signer;
  chains: ChainAdapter[];
  /** Test-only: override the global `fetch`. */
  fetchFn?: typeof fetch;
};

export type PayAndFetchResult = {
  status: number;
  body: unknown;
  /** True if a payment was made (i.e. we hit the 402 path and got a 200). */
  paid: boolean;
  /** The 402 requirement we paid against, if any. */
  paidRequirements?: PaymentRequirements;
  /** Settle tx hash from `X-PAYMENT-RESPONSE`, if the server emitted it. */
  settledTx?: string;
};

export async function payAndFetch(opts: PayAndFetchOptions): Promise<PayAndFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const method = opts.method ?? 'GET';

  const baseHeaders: Record<string, string> = {};
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    baseHeaders['content-type'] = 'application/json';
  }

  // 1) Initial request.
  const r1 = await fetchFn(opts.url, { method, headers: baseHeaders, body });
  if (r1.status !== 402) {
    return { status: r1.status, body: await tryJson(r1), paid: false };
  }

  // 2) Parse challenge & pick a payment option we can satisfy.
  const challenge = (await r1.json()) as Challenge;
  const picked = pickRequirements(challenge, opts.chains);
  if (!picked) {
    throw new Error(
      'no chain adapter for any of the offered networks: ' +
        challenge.accepts.map((a) => `${a.scheme}/${a.network}`).join(', '),
    );
  }
  const { reqs, adapter } = picked;

  // 3-4) Build + sign.
  const { typedData, authorization } = adapter.buildPayment(reqs, opts.signer.address);
  const signature = await opts.signer.signTypedData(typedData);

  logger.info('x402 payment built', {
    host: new URL(opts.url).host,
    chain: adapter.id,
    amount: reqs.maxAmountRequired,
  });

  // 5) Encode `X-PAYMENT`.
  const paymentPayload: PaymentPayload = {
    x402Version: challenge.x402Version,
    scheme: reqs.scheme,
    network: reqs.network,
    payload: { signature, authorization },
  };
  const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // 6) Re-request with the payment header.
  const r2 = await fetchFn(opts.url, {
    method,
    headers: { ...baseHeaders, 'X-PAYMENT': xPayment },
    body,
  });

  // 7) Decode `X-PAYMENT-RESPONSE` (best-effort — the CDP facilitator
  //    sometimes omits this header; we still trust the 200 status).
  let settledTx: string | undefined;
  const xPaymentResponse = r2.headers.get('x-payment-response');
  if (xPaymentResponse) {
    try {
      const decoded = JSON.parse(
        Buffer.from(xPaymentResponse, 'base64').toString('utf8'),
      );
      if (typeof decoded?.transaction === 'string') {
        settledTx = decoded.transaction;
      }
    } catch {
      // ignore — settledTx stays undefined
    }
  }

  return {
    status: r2.status,
    body: await tryJson(r2),
    paid: r2.status === 200,
    paidRequirements: reqs,
    settledTx,
  };
}

function pickRequirements(
  challenge: Challenge,
  chains: ChainAdapter[],
): { reqs: PaymentRequirements; adapter: ChainAdapter } | null {
  for (const reqs of challenge.accepts) {
    if (reqs.scheme !== 'exact') continue;
    const adapter = chains.find((c) => c.matches(reqs.network));
    if (adapter) return { reqs, adapter };
  }
  return null;
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
