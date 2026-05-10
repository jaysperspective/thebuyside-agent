/**
 * EnvSolanaKeySigner — backs the SolanaSigner interface with a Solana
 * Keypair loaded from the environment (X402_PAYER_SOLANA_KEY).
 *
 * Accepts two key formats so users don't have to convert between them:
 *   1. base58 — the format Phantom and most browser wallets export.
 *      Decoded via @solana/web3.js's bs58 helper. ~87-88 chars.
 *   2. JSON array — what `solana-keygen new` writes to id.json
 *      (e.g. `[123, 45, 200, ...]`, length 64). Detected by leading `[`.
 *
 * Both decode to the canonical 64-byte secret key, from which the public
 * key is derived deterministically.
 *
 * Security note: same caveat as the EVM signer — the key is held in
 * process memory for the lifetime of the gateway. v0 trusts local OS /
 * file permissions on `.env`; production should swap in a KMS-backed
 * signer.
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { SolanaSigner } from './signer.js';

export class EnvSolanaKeySigner implements SolanaSigner {
  readonly kind = 'svm' as const;
  readonly publicKey: string;
  private readonly keypair: Keypair;

  constructor(rawKey: string) {
    this.keypair = decodeSolanaKey(rawKey);
    this.publicKey = this.keypair.publicKey.toBase58();
  }

  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}

function decodeSolanaKey(raw: string): Keypair {
  const trimmed = raw.trim();
  let secret: Uint8Array;

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        'X402_PAYER_SOLANA_KEY looks like JSON-array format but is not valid JSON.',
      );
    }
    if (!Array.isArray(parsed) || parsed.some((b) => typeof b !== 'number')) {
      throw new Error(
        'X402_PAYER_SOLANA_KEY JSON-array form must be an array of byte values.',
      );
    }
    if (parsed.length !== 64) {
      throw new Error(
        `X402_PAYER_SOLANA_KEY JSON-array form must contain 64 bytes (got ${parsed.length}).`,
      );
    }
    secret = Uint8Array.from(parsed as number[]);
  } else {
    try {
      secret = bs58.decode(trimmed);
    } catch {
      throw new Error(
        'X402_PAYER_SOLANA_KEY is set but is neither a valid base58 string nor a JSON array.',
      );
    }
    if (secret.length !== 64) {
      throw new Error(
        `X402_PAYER_SOLANA_KEY base58 form must decode to 64 bytes (got ${secret.length}).`,
      );
    }
  }

  return Keypair.fromSecretKey(secret);
}
