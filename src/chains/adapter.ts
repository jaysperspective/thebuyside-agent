/**
 * ChainAdapter — encapsulates per-chain knowledge: network identifier
 * matching, EIP-712 domain, and how to build the typed-data + authorization
 * payload for an x402 payment.
 *
 * v0 has one implementation: `BaseUsdcAdapter`. Adding Solana (Pay.sh) for
 * v0.2 means writing one new class and registering it; no rewrite.
 *
 * Note: the return type is currently EVM-shaped (EIP-712 typed data). When
 * Solana lands we'll either widen this interface or split it into
 * `EvmChainAdapter` / `SolanaChainAdapter` siblings — both are clean changes
 * from here.
 */

import type { Address } from 'viem';
import type { Eip712TypedData } from '../signer/signer.js';
import type { Authorization, PaymentRequirements } from '../x402/types.js';

export interface ChainAdapter {
  /** Short identifier used in logs and receipts (e.g. 'base', 'solana'). */
  readonly id: string;

  /** Returns true if this adapter handles the network ID in a 402 challenge. */
  matches(network: string): boolean;

  /**
   * Build the data to sign and the authorization body for a given payment
   * requirement. The gateway then signs `typedData` with its `Signer`,
   * combines the signature with `authorization`, and base64-encodes the
   * whole thing into the `X-PAYMENT` header.
   */
  buildPayment(
    reqs: PaymentRequirements,
    payerAddress: Address,
  ): { typedData: Eip712TypedData; authorization: Authorization };
}
