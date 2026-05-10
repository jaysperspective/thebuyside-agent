/**
 * Config loader. Reads `.env` (via dotenv) and validates env vars at startup.
 *
 * Wallet keys are optional at boot — the gateway boots and lists tools
 * without any keys; payment-shaped tools simply error if asked to pay
 * on a chain without a configured signer. Users can configure EVM only,
 * Solana only, or both.
 *
 * `.env` is loaded by absolute path (relative to this file) so the gateway
 * works correctly when spawned from any cwd — e.g. by Claude Desktop, where
 * the working directory is not guaranteed to be the project root.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { Hex } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
loadDotenv({ path: resolve(projectRoot, '.env') });

export type Config = {
  /** Hex 0x-prefixed EVM private key, or null if unset / placeholder. */
  payerPrivateKey: Hex | null;
  /**
   * Solana secret key in either base58 (Phantom export) or
   * JSON-array (solana-keygen output) format. Stored as the raw string;
   * the signer decodes + validates. Null if unset / placeholder.
   */
  payerSolanaKey: string | null;
};

function parsePrivateKey(raw: string | undefined): Hex | null {
  if (!raw) return null;
  if (raw === '0xPASTE_YOUR_PRIVATE_KEY_HERE') return null;
  if (!raw.startsWith('0x') || raw.length !== 66) {
    throw new Error(
      'X402_PAYER_PRIVATE_KEY is set but malformed. Expected 0x-prefixed 64 hex chars.',
    );
  }
  return raw as Hex;
}

function parseSolanaKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'PASTE_YOUR_SOLANA_KEY_HERE') return null;
  return trimmed;
}

export function loadConfig(): Config {
  return {
    payerPrivateKey: parsePrivateKey(process.env.X402_PAYER_PRIVATE_KEY),
    payerSolanaKey: parseSolanaKey(process.env.X402_PAYER_SOLANA_KEY),
  };
}
