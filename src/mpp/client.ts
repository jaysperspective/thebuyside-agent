/**
 * MPP (Machine Payments Protocol) client — drives the full payment loop
 * for the `solana`/`charge` intent per paymentauth.org/draft-solana-charge-00:
 *
 *   1. Make the initial request.
 *   2. If 402 with `WWW-Authenticate: Payment ...`, parse the challenge and
 *      decode the base64url JCS `request` payload.
 *   3. Validate scope (USDC mint, standard SPL Token, pull mode, network).
 *   4. Have `SolanaUsdcAdapter.buildPaymentMpp` build the partially-signed tx.
 *   5. Sign with the buyer's Solana key.
 *   6. Wrap in a JCS-canonical credential JSON, base64url-encode, send as
 *      `Authorization: Payment <b64url>`.
 *   7. On 200, decode the `Payment-Receipt` header.
 *
 * No spend-policy enforcement here — that lives in `src/policy/` and is wired
 * by the calling fetch tool via the `beforePay` / `onPaid` hooks. Mirrors the
 * shape of `src/x402/client.ts` so the two protocols feel symmetric.
 */

import type { SolanaUsdcAdapter } from '../chains/solana-usdc.js';
import { logger } from '../log.js';
import type { SolanaSigner } from '../signer/signer.js';
import {
  isMppChallengeHeader,
  parsePaymentChallenge,
  buildAuthorizationHeader,
} from './auth-header.js';
import { decodeJcsBase64Url, jcsBase64Url, jcsStringify } from './jcs.js';
import type {
  ChargeRequest,
  Credential,
  PaymentReceipt,
} from './types.js';
import { USDC_MAINNET_MINT } from './types.js';

/** Network slugs we treat as Solana mainnet for the purposes of MPP. */
const MAINNET_SLUGS = new Set(['mainnet', 'mainnet-beta', 'solana']);

export type MppPayAndFetchOptions = {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signer: SolanaSigner;
  adapter: SolanaUsdcAdapter;
  /** Test-only: override the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Optimization: the caller already fetched the initial response and
   * confirmed it's a 402 with an MPP challenge. Skips the duplicate GET.
   */
  prefetchedResponse?: Response;
  /**
   * If true, accept non-mainnet networks (`devnet`, `testnet`, `localnet`).
   * Off by default — production callers should only pay real money on
   * mainnet. Used by integration tests and the pay.sh debugger probe.
   */
  allowNonMainnet?: boolean;
  /** Pre-pay hook. Throw to abort before any signature is produced. */
  beforePay?: (charge: ChargeRequest) => Promise<void> | void;
  /** Post-pay hook. Called only on 200; receives the settle tx signature. */
  onPaid?: (info: { charge: ChargeRequest; tx: string | undefined }) => Promise<void> | void;
};

export type MppPayAndFetchResult = {
  status: number;
  body: unknown;
  paid: boolean;
  /** The decoded MPP charge we paid against, if any. */
  paidCharge?: ChargeRequest;
  /** Solana tx signature from `Payment-Receipt`, if the server emitted one. */
  settledTx?: string;
  /** Populated when the retry returns non-200. */
  failure?: { status: number; body: unknown };
};

export async function payAndFetchMpp(
  opts: MppPayAndFetchOptions,
): Promise<MppPayAndFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const method = opts.method ?? 'GET';

  const baseHeaders: Record<string, string> = {};
  let serializedBody: string | undefined;
  if (opts.body !== undefined) {
    serializedBody = JSON.stringify(opts.body);
    baseHeaders['content-type'] = 'application/json';
  }

  const r1 =
    opts.prefetchedResponse ??
    (await fetchFn(opts.url, { method, headers: baseHeaders, body: serializedBody }));

  if (r1.status !== 402) {
    return { status: r1.status, body: await tryJson(r1), paid: false };
  }

  const wwwAuth = r1.headers.get('www-authenticate');
  if (!isMppChallengeHeader(wwwAuth)) {
    throw new Error(
      '402 response did not advertise an MPP `Payment` challenge in the ' +
        'WWW-Authenticate header — this endpoint may speak x402 instead.',
    );
  }

  const challenge = parsePaymentChallenge(wwwAuth as string);
  if (challenge.method.toLowerCase() !== 'solana') {
    throw new Error(
      `MPP method="${challenge.method}" is not supported; only "solana" is ` +
        `implemented in v0.5.0.`,
    );
  }
  if (challenge.intent.toLowerCase() !== 'charge') {
    throw new Error(
      `MPP intent="${challenge.intent}" is not supported; only "charge" is ` +
        `implemented in v0.5.0.`,
    );
  }
  if (Date.parse(challenge.expires) <= Date.now()) {
    throw new Error(
      `MPP challenge already expired at ${challenge.expires}; seller clock ` +
        `may be skewed or the challenge expiry window is too short.`,
    );
  }

  const charge = decodeJcsBase64Url(challenge.request) as ChargeRequest;
  validateChargeShape(charge);

  if (charge.currency !== USDC_MAINNET_MINT) {
    throw new Error(
      `MPP charge currency=${charge.currency} not supported; v0.5.0 honors ` +
        `only the USDC mainnet mint (${USDC_MAINNET_MINT}).`,
    );
  }

  if (!opts.allowNonMainnet && !MAINNET_SLUGS.has(charge.methodDetails.network)) {
    throw new Error(
      `MPP charge network=${charge.methodDetails.network} rejected — pass ` +
        `allowNonMainnet=true to opt into devnet/testnet/localnet.`,
    );
  }

  if (opts.signer.publicKey === charge.recipient) {
    throw new Error(
      `payer pubkey (${opts.signer.publicKey}) is the same as the seller's ` +
        `recipient address — you cannot pay yourself. Configure a different ` +
        `X402_PAYER_SOLANA_KEY.`,
    );
  }

  if (opts.beforePay) {
    await opts.beforePay(charge);
  }

  const { tx } = await opts.adapter.buildPaymentMpp(charge, opts.signer.publicKey);
  const signed = await opts.signer.signTransaction(tx);
  const serialized = signed.serialize();
  const transactionB64 = Buffer.from(serialized).toString('base64');

  const credential: Credential = {
    challenge: {
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      expires: challenge.expires,
    },
    source: opts.signer.publicKey,
    payload: { type: 'transaction', transaction: transactionB64 },
  };
  const credentialCanonical = jcsStringify(credential);
  const credentialB64Url = jcsBase64Url(credential);

  logger.info('mpp payment built', {
    host: new URL(opts.url).host,
    challengeId: challenge.id,
    amount: charge.amount,
    network: charge.methodDetails.network,
  });

  // Opt-in byte-level dump of the outgoing canonical credential, for
  // debugging JCS-divergence with a seller in pair-test. Off by default.
  if (process.env.X402_MPP_DEBUG === '1') {
    logger.info('mpp debug: outgoing credential canonical bytes', {
      bytes: credentialCanonical.length,
      canonical: credentialCanonical,
    });
    const msgBytes = signed.message.serialize();
    const numSigners = signed.message.header.numRequiredSignatures;
    const signerKeys = signed.message.staticAccountKeys.slice(0, numSigners).map((k) => k.toBase58());
    const buyerIndex = signerKeys.indexOf(opts.signer.publicKey);
    const buyerSig = buyerIndex >= 0 ? signed.signatures[buyerIndex] : null;
    logger.info('mpp debug: signed tx internals', {
      numRequiredSignatures: numSigners,
      signerKeys,
      buyerIndex,
      buyerPubkey: opts.signer.publicKey,
      buyerSigHex: buyerSig ? Buffer.from(buyerSig).toString('hex') : null,
      messageHex: Buffer.from(msgBytes).toString('hex'),
      messageBytes: msgBytes.length,
    });
  }

  const r2 = await fetchFn(opts.url, {
    method,
    headers: {
      ...baseHeaders,
      authorization: buildAuthorizationHeader(credentialB64Url),
    },
    body: serializedBody,
  });

  let settledTx: string | undefined;
  const receiptHeader = r2.headers.get('payment-receipt');
  if (receiptHeader) {
    try {
      const decoded = decodeJcsBase64Url(receiptHeader) as PaymentReceipt;
      if (typeof decoded?.txSignature === 'string') {
        settledTx = decoded.txSignature;
      }
    } catch {
      // Receipt was unparseable — still trust the 200 status.
    }
  }

  const body = await tryJson(r2);

  if (r2.status === 200 && opts.onPaid) {
    await opts.onPaid({ charge, tx: settledTx });
  }

  if (r2.status !== 200) {
    logger.warn('mpp retry rejected', {
      status: r2.status,
      host: new URL(opts.url).host,
      challengeId: challenge.id,
    });
    return {
      status: r2.status,
      body,
      paid: false,
      paidCharge: charge,
      failure: { status: r2.status, body },
    };
  }

  return {
    status: r2.status,
    body,
    paid: true,
    paidCharge: charge,
    settledTx,
  };
}

function validateChargeShape(charge: unknown): asserts charge is ChargeRequest {
  if (!charge || typeof charge !== 'object') {
    throw new Error('MPP charge request payload is not an object');
  }
  const c = charge as Record<string, unknown>;
  const requiredTop = ['amount', 'currency', 'recipient', 'methodDetails'];
  for (const k of requiredTop) {
    if (!(k in c)) throw new Error(`MPP charge missing required field "${k}"`);
  }
  if (typeof c.amount !== 'string') {
    throw new Error('MPP charge "amount" must be a decimal string');
  }
  if (typeof c.currency !== 'string') {
    throw new Error('MPP charge "currency" must be a string');
  }
  if (typeof c.recipient !== 'string') {
    throw new Error('MPP charge "recipient" must be a string');
  }
  const md = c.methodDetails as Record<string, unknown>;
  if (!md || typeof md !== 'object') {
    throw new Error('MPP charge "methodDetails" must be an object');
  }
  const requiredMd = ['decimals', 'feePayer', 'network', 'recentBlockhash', 'tokenProgram'];
  for (const k of requiredMd) {
    if (!(k in md)) throw new Error(`MPP charge methodDetails missing "${k}"`);
  }
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
