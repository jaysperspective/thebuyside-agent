/**
 * x402 client — drives the full payment loop:
 *   1. Make the request.
 *   2. If the server returns 402, parse the challenge (handles both x402 v1
 *      and v2 wire shapes — see parseChallenge below) and pick a payment
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

import type { Address } from 'viem';
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
  /**
   * Called after parsing the 402 challenge, before signing. Throw to abort.
   * The thrown error propagates to the caller — no signature is generated,
   * no funds are moved. Used by the gateway to enforce spend caps.
   */
  beforePay?: (reqs: PaymentRequirements) => Promise<void> | void;
  /**
   * Called after a successful (200) paid response. Receives the requirements
   * paid and the settle tx hash (or undefined if the facilitator omitted the
   * X-PAYMENT-RESPONSE header). Used by the gateway to record receipts.
   * Errors thrown here propagate to the caller.
   */
  onPaid?: (info: { reqs: PaymentRequirements; tx: string | undefined }) => Promise<void> | void;
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
  /**
   * Populated when the retry (with X-PAYMENT) returns non-200. Carries the
   * full response headers and a decoded `payment-required` payload so the
   * caller can surface the rejection reason. v2 facilitators put the
   * rejection detail in headers, not the body — without this we can't
   * tell why a payment was rejected.
   */
  failureDiagnostics?: FailureDiagnostics;
};

export type FailureDiagnostics = {
  headers: Record<string, string>;
  /** Decoded `payment-required` header (base64 JSON), if present. */
  paymentRequired?: unknown;
};

export async function payAndFetch(opts: PayAndFetchOptions): Promise<PayAndFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const method = opts.method ?? 'GET';

  const baseHeaders: Record<string, string> = {};
  let serializedBody: string | undefined;
  if (opts.body !== undefined) {
    serializedBody = JSON.stringify(opts.body);
    baseHeaders['content-type'] = 'application/json';
  }

  // 1) Initial request.
  const r1 = await fetchFn(opts.url, { method, headers: baseHeaders, body: serializedBody });
  if (r1.status !== 402) {
    return { status: r1.status, body: await tryJson(r1), paid: false };
  }

  // 2) Parse challenge & pick a payment option we can satisfy.
  const challenge = await parseChallenge(r1);
  const picked = pickRequirements(challenge, opts.chains);
  if (!picked) {
    throw new Error(
      'no chain adapter for any of the offered networks: ' +
        challenge.accepts.map((a) => `${a.scheme}/${a.network}`).join(', '),
    );
  }
  const { reqs, adapter } = picked;

  // 2.5) Pre-pay hook (caps, ad-hoc policies). Errors abort.
  if (opts.beforePay) {
    await opts.beforePay(reqs);
  }

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
    body: serializedBody,
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

  const body = await tryJson(r2);

  // 7.5) Post-pay hook (record receipt). Only on 200.
  if (r2.status === 200 && opts.onPaid) {
    await opts.onPaid({ reqs, tx: settledTx });
  }

  // 7.75) Diagnostics on rejection — capture headers so the caller can
  //       surface the facilitator's rejection reason.
  let failureDiagnostics: FailureDiagnostics | undefined;
  if (r2.status !== 200) {
    failureDiagnostics = captureFailure(r2);
    logger.warn('x402 retry rejected', {
      status: r2.status,
      host: new URL(opts.url).host,
      headers: failureDiagnostics.headers,
      paymentRequired: failureDiagnostics.paymentRequired,
    });
  }

  return {
    status: r2.status,
    body,
    paid: r2.status === 200,
    paidRequirements: reqs,
    settledTx,
    failureDiagnostics,
  };
}

function captureFailure(r: Response): FailureDiagnostics {
  const headers: Record<string, string> = {};
  r.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let paymentRequired: unknown;
  const pr = headers['payment-required'];
  if (pr) {
    try {
      paymentRequired = JSON.parse(Buffer.from(pr, 'base64').toString('utf8'));
    } catch {
      // leave undefined — header was present but not decodable
    }
  }
  return { headers, paymentRequired };
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

/**
 * Parse an HTTP 402 response into our internal `Challenge` type, handling
 * both x402 wire shapes:
 *
 *   v1 — challenge JSON in the response body. accepts[].maxAmountRequired,
 *        accepts[].resource is a string.
 *
 *   v2 — challenge in the `payment-required` response header (base64 JSON);
 *        body is `{}`. accepts[].amount (renamed). resource moved to top
 *        level as `{ url, description, mimeType }`. network in CAIP-2.
 *
 * Both are normalized into the v1-shaped internal `Challenge`/
 * `PaymentRequirements` types so the rest of the code (adapters, signers,
 * X-PAYMENT builder) is version-agnostic.
 */
export async function parseChallenge(response: Response): Promise<Challenge> {
  const v2Header = response.headers.get('payment-required');
  if (v2Header && v2Header.length > 0) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(v2Header, 'base64').toString('utf8'));
    } catch {
      throw new Error('payment-required header was not valid base64 JSON');
    }
    return normalizeChallenge(decoded);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      '402 response had no `payment-required` header and body was not JSON',
    );
  }
  return normalizeChallenge(body);
}

type RawAccept = {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string;
  amount?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo?: Address;
  maxTimeoutSeconds?: number;
  asset?: Address;
  extra?: { name: string; version: string };
};
type RawChallenge = {
  x402Version?: number;
  error?: string;
  resource?: string | { url?: string; description?: string; mimeType?: string };
  accepts?: RawAccept[];
};

function normalizeChallenge(raw: unknown): Challenge {
  const r = (raw ?? {}) as RawChallenge;
  const topResource =
    typeof r.resource === 'object' && r.resource !== null ? r.resource : null;

  const accepts: PaymentRequirements[] = (r.accepts ?? []).map((a) => ({
    scheme: a.scheme as 'exact',
    network: a.network ?? '',
    maxAmountRequired: a.maxAmountRequired ?? a.amount ?? '0',
    resource: topResource?.url ?? a.resource ?? '',
    description: topResource?.description ?? a.description,
    mimeType: topResource?.mimeType ?? a.mimeType,
    payTo: (a.payTo ?? '0x0000000000000000000000000000000000000000') as Address,
    maxTimeoutSeconds: a.maxTimeoutSeconds ?? 60,
    asset: (a.asset ?? '0x0000000000000000000000000000000000000000') as Address,
    extra: a.extra ?? { name: '', version: '' },
  }));

  return {
    x402Version: r.x402Version ?? 1,
    error: r.error,
    accepts,
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
