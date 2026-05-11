/**
 * Wire-level types for the MPP (Machine Payments Protocol) `solana` / `charge`
 * intent, per paymentauth.org/draft-solana-charge-00.
 *
 * MPP rides on RFC 7235 HTTP Authentication (not x402's bespoke headers), so
 * the buyer-side surface is: parse a `WWW-Authenticate: Payment ...` header,
 * decode the embedded JCS-canonical `request` JSON, sign a Solana transaction,
 * wrap it in a credential, JCS-encode that, send back as
 * `Authorization: Payment <base64url>`, and on success read a `Payment-Receipt`
 * header.
 *
 * Scope (v0.5.0):
 *   - method=solana, intent=charge only
 *   - pull mode (payload.type=transaction, server is feePayer + broadcasts)
 *   - USDC SPL token on Solana mainnet
 *   - Push mode, raw SOL, splits, Token-2022 are deferred.
 */

/** Decoded inner JSON from the base64url `request` auth-param. */
export type ChargeRequest = {
  /** Atomic units of the asset, decimal string (e.g. "10000" = 0.01 USDC). */
  amount: string;
  /**
   * SPL mint address (e.g. USDC mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
   * OR the literal string `"sol"` for native SOL. We only honor the USDC mint
   * in v0.5.0; anything else is rejected at validation time.
   */
  currency: string;
  /** Seller's Solana receive pubkey (base58). */
  recipient: string;
  /** Optional human label some sellers include here instead of as an auth-param. */
  description?: string;
  methodDetails: MethodDetails;
};

export type MethodDetails = {
  /** Token decimals (USDC = 6). */
  decimals: number;
  /**
   * True → pull mode: server co-signs as feePayer and broadcasts. Buyer
   * partially-signs only as transfer authority. False/absent → buyer must
   * be feePayer and fully sign (push mode); not supported in v0.5.0.
   */
  feePayer: boolean;
  /** Server's facilitator pubkey when `feePayer: true`. */
  feePayerKey?: string;
  /** Network slug: `mainnet`, `devnet`, `testnet`, `localnet`. */
  network: string;
  /** Fresh Solana blockhash (~60 sec validity). */
  recentBlockhash: string;
  /** SPL Token program ID. Standard SPL: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. */
  tokenProgram: string;
};

/** Inner challenge object echoed back inside the credential. */
export type ChallengeEnvelope = {
  id: string;
  realm: string;
  method: string;
  intent: string;
  /** The original base64url(JCS(ChargeRequest)) string, unmodified. */
  request: string;
  expires: string;
};

/** Credential JSON the buyer JCS-encodes + base64url-encodes for `Authorization: Payment ...`. */
export type Credential = {
  challenge: ChallengeEnvelope;
  /** Buyer's Solana pubkey (base58). */
  source: string;
  payload: TransactionPayload;
};

/** Pull-mode payload: serialized partially-signed Solana VersionedTransaction. */
export type TransactionPayload = {
  type: 'transaction';
  /** Base64 (NOT base64url) of the serialized VersionedTransaction. */
  transaction: string;
};

/** Receipt JSON inside the `Payment-Receipt` response header (base64url JCS). */
export type PaymentReceipt = {
  /** Atomic units settled, decimal string — echoes ChargeRequest.amount. */
  amount: string;
  challengeId: string;
  /** Asset settled — echoes ChargeRequest.currency (USDC mint or "sol"). */
  currency: string;
  network: string;
  /** Seller's Solana receive pubkey — echoes ChargeRequest.recipient. */
  recipient: string;
  /** ISO-8601 timestamp of on-chain confirmation. */
  settledAt: string;
  /** Solana slot the settle tx landed in. */
  slot: number;
  /** Buyer's Solana pubkey — echoes Credential.source. */
  source: string;
  /** Base58 Solana transaction signature — independently verifiable on-chain. */
  txSignature: string;
};

/** USDC mint address on Solana mainnet. The only `currency` value we honor. */
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
