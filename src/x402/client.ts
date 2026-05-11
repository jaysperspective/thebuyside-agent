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
import type { ChainAdapter, ChainKind } from '../chains/adapter.js';
import { logger } from '../log.js';
import type { EvmSigner, SolanaSigner } from '../signer/signer.js';
import type { Challenge, PaymentPayload, PaymentRequirements } from './types.js';

export type SignerSet = {
  evm: EvmSigner | null;
  svm: SolanaSigner | null;
};

export type PayAndFetchOptions = {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signers: SignerSet;
  chains: ChainAdapter[];
  /** Test-only: override the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Optimization: the caller already fetched the initial response (typically
   * because it peeked at the 402 headers to dispatch between x402 and MPP).
   * Skips the duplicate GET. Must be a 402; non-402 prefetched responses
   * are returned as-is.
   */
  prefetchedResponse?: Response;
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

  // 1) Initial request. Reuse the caller-prefetched response when present
  //    (the unified pay.fetch tool does the first GET to detect MPP vs x402).
  const r1 =
    opts.prefetchedResponse ??
    (await fetchFn(opts.url, { method, headers: baseHeaders, body: serializedBody }));
  if (r1.status !== 402) {
    return { status: r1.status, body: await tryJson(r1), paid: false };
  }

  // 2) Parse challenge & pick a payment option we can satisfy. We need
  //    BOTH a chain adapter for the offered network AND a signer for that
  //    adapter's kind — pickRequirements considers both.
  const challenge = await parseChallenge(r1);
  const picked = pickRequirements(challenge, opts.chains, opts.signers);
  if (!picked) {
    throw new Error(
      'no chain adapter + matching signer for any of the offered networks: ' +
        challenge.accepts.map((a) => `${a.scheme}/${a.network}`).join(', ') +
        '. Configured signers: ' +
        configuredSignerKinds(opts.signers).join(', '),
    );
  }
  const { reqs, adapter } = picked;
  const payerAddressForLog = signerAddressFor(adapter.kind, opts.signers);

  // 2.4) Sanity: refuse to sign if the payer wallet IS the receiver wallet.
  //       Self-transfers are nonsensical and CDP's facilitator rejects them
  //       as `invalid_payload`. Per-chain because address formats differ
  //       (EVM = 0x-hex case-insensitive; Solana = base58 case-sensitive).
  assertNotSelfPay(adapter.kind, opts.signers, reqs);

  // 2.5) Merge top-level challenge extensions into the picked reqs so
  //      consumers (caps, confirm prompt) see a single combined extension
  //      bag. Per-accept extensions take precedence on key collision.
  if (challenge.extensions || reqs.extensions) {
    reqs.extensions = { ...(challenge.extensions ?? {}), ...(reqs.extensions ?? {}) };
  }

  // 2.6) Pre-pay hook (caps, ad-hoc policies). Errors abort.
  if (opts.beforePay) {
    await opts.beforePay(reqs);
  }

  // 3-4-5) Build + sign + encode. Branches by chain kind because EVM and
  //        SVM have entirely different signing models — EIP-712 + EIP-3009
  //        for EVM vs partially-signed VersionedTransaction for Solana —
  //        and the v2 payload shape differs accordingly.
  const isV2 = (challenge.x402Version ?? 1) >= 2;
  let payload: Record<string, unknown>;
  if (adapter.kind === 'evm') {
    const signer = opts.signers.evm!; // pickRequirements guarantees presence
    const { typedData, authorization } = adapter.buildPayment(reqs, signer.address);
    const signature = await signer.signTypedData(typedData);
    payload = { signature, authorization };
  } else {
    const signer = opts.signers.svm!;
    const { tx } = await adapter.buildPayment(reqs, signer.publicKey);
    const signed = await signer.signTransaction(tx);
    const serialized = signed.serialize();
    const transactionB64 = Buffer.from(serialized).toString('base64');
    payload = { transaction: transactionB64 };
  }

  logger.info('x402 payment built', {
    host: new URL(opts.url).host,
    chain: adapter.id,
    kind: adapter.kind,
    amount: reqs.maxAmountRequired,
    x402Version: challenge.x402Version,
  });

  // v1 wire format only ever supported the EVM payload shape — it was
  // defined before SVM landed. SVM payments require v2, which all current
  // SVM facilitators emit anyway.
  if (adapter.kind === 'svm' && !isV2) {
    throw new Error(
      'Solana payments require x402 v2; seller advertised an x402 v1 challenge.',
    );
  }

  const paymentBody: unknown = isV2
    ? {
        x402Version: 2,
        resource: {
          url: reqs.resource,
          description: reqs.description ?? '',
          mimeType: reqs.mimeType ?? '',
        },
        accepted: {
          scheme: reqs.scheme,
          network: reqs.network,
          amount: reqs.maxAmountRequired,
          asset: reqs.asset,
          payTo: reqs.payTo,
          maxTimeoutSeconds: reqs.maxTimeoutSeconds,
          extra: reqs.extra,
        },
        payload,
      }
    : ({
        x402Version: 1,
        scheme: reqs.scheme,
        network: reqs.network,
        payload: payload as PaymentPayload['payload'],
      } satisfies PaymentPayload);
  const encodedPayment = Buffer.from(JSON.stringify(paymentBody)).toString('base64');
  const paymentHeaderName = isV2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
  void payerAddressForLog; // surfaced to callers via paidRequirements + logs already

  // 6) Re-request with the payment header.
  const r2 = await fetchFn(opts.url, {
    method,
    headers: { ...baseHeaders, [paymentHeaderName]: encodedPayment },
    body: serializedBody,
  });

  // 7) Decode the settle-tx response header (v2: PAYMENT-RESPONSE,
  //    v1: X-PAYMENT-RESPONSE). CDP middleware sometimes omits this
  //    even on success — we still trust the 200 status.
  let settledTx: string | undefined;
  const settleHeader =
    r2.headers.get('payment-response') ?? r2.headers.get('x-payment-response');
  if (settleHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(settleHeader, 'base64').toString('utf8'),
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
  signers: SignerSet,
): { reqs: PaymentRequirements; adapter: ChainAdapter } | null {
  for (const reqs of challenge.accepts) {
    if (reqs.scheme !== 'exact') continue;
    const adapter = chains.find((c) => c.matches(reqs.network));
    if (!adapter) continue;
    // Skip adapters whose kind has no configured signer — surface a clear
    // "no signer" error one frame up rather than failing inside buildPayment.
    if (adapter.kind === 'evm' && signers.evm === null) continue;
    if (adapter.kind === 'svm' && signers.svm === null) continue;
    return { reqs, adapter };
  }
  return null;
}

function configuredSignerKinds(signers: SignerSet): ChainKind[] {
  const out: ChainKind[] = [];
  if (signers.evm) out.push('evm');
  if (signers.svm) out.push('svm');
  return out;
}

function signerAddressFor(kind: ChainKind, signers: SignerSet): string {
  if (kind === 'evm') return signers.evm?.address ?? '(none)';
  return signers.svm?.publicKey ?? '(none)';
}

function assertNotSelfPay(
  kind: ChainKind,
  signers: SignerSet,
  reqs: PaymentRequirements,
): void {
  if (kind === 'evm' && signers.evm) {
    if (signers.evm.address.toLowerCase() === reqs.payTo.toLowerCase()) {
      throw new Error(
        `payer wallet (${signers.evm.address}) is the same as the seller's ` +
          `payTo address — you cannot pay yourself. Configure a different ` +
          `X402_PAYER_PRIVATE_KEY (a wallet you control that is NOT the ` +
          `seller's receiving wallet).`,
      );
    }
  } else if (kind === 'svm' && signers.svm) {
    if (signers.svm.publicKey === reqs.payTo) {
      throw new Error(
        `payer pubkey (${signers.svm.publicKey}) is the same as the seller's ` +
          `payTo address — you cannot pay yourself. Configure a different ` +
          `X402_PAYER_SOLANA_KEY.`,
      );
    }
  }
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
  extra?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};
type RawChallenge = {
  x402Version?: number;
  error?: string;
  resource?: string | { url?: string; description?: string; mimeType?: string };
  accepts?: RawAccept[];
  extensions?: Record<string, unknown>;
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
    extra: a.extra ?? {},
    extensions: a.extensions,
  }));

  return {
    x402Version: r.x402Version ?? 1,
    error: r.error,
    accepts,
    extensions: r.extensions,
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
