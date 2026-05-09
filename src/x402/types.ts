/**
 * Wire-level types for the x402 v1 protocol.
 *
 * Spec reference: https://x402.org/  (Linux Foundation–stewarded as of 2026)
 *
 * Notes:
 *  - Numeric fields (`maxAmountRequired`, `value`, `validAfter`, `validBefore`)
 *    are decimal strings on the wire to avoid JS bigint loss-of-precision.
 *  - `network` may be either the canonical short form ("base", "base-sepolia")
 *    or a CAIP-2 identifier ("eip155:8453"). Chain adapters handle matching.
 */

import type { Address, Hex } from 'viem';

/** A single payment option presented in a 402 challenge. */
export type PaymentRequirements = {
  scheme: 'exact';
  network: string;
  /** Atomic units of the asset (USDC has 6 decimals: 5000 = $0.005). */
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  /** ERC-20 contract address for the asset (e.g. USDC on Base). */
  asset: Address;
  /**
   * EIP-712 domain identity for the asset's `transferWithAuthorization`.
   * Critical: Base mainnet USDC's EIP-712 name is "USD Coin" (NOT "USDC").
   */
  extra: { name: string; version: string };
};

/** Body of a 402 response. */
export type Challenge = {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
};

/** EIP-3009 authorization, in the wire shape (decimal strings). */
export type Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

/** Full payload that goes inside the base64-encoded `X-PAYMENT` header. */
export type PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: Authorization;
  };
};
