/**
 * ChainAdapter — encapsulates per-chain knowledge: network identifier
 * matching and how to build the payment payload for an x402 challenge.
 *
 * The interface is a discriminated union because EVM and SVM (Solana)
 * have fundamentally different signing models — EVM signs EIP-712 typed
 * data and produces an EIP-3009 authorization, SVM partially-signs a
 * full Solana transaction. Branching on `kind` keeps each chain's path
 * straightforward; widening to a single shared shape would force a lot
 * of conditionals + casts down the call chain.
 *
 * Adding a new chain = add a sibling interface here and a class in the
 * same shape. The protocol loop (`payAndFetch`) is the only place that
 * needs a new branch.
 */

import type { Address } from 'viem';
import type { VersionedTransaction } from '@solana/web3.js';
import type { Eip712TypedData } from '../signer/signer.js';
import type { Authorization, PaymentRequirements } from '../x402/types.js';

export type ChainKind = 'evm' | 'svm';

export interface ChainAdapterBase {
  /** Short identifier used in logs and receipts (e.g. 'base', 'solana'). */
  readonly id: string;
  /** Discriminator for which signing pipeline this adapter slots into. */
  readonly kind: ChainKind;
  /** Returns true if this adapter handles the network ID in a 402 challenge. */
  matches(network: string): boolean;
}

export interface EvmChainAdapter extends ChainAdapterBase {
  readonly kind: 'evm';
  /**
   * Build the data to sign and the authorization body for a given payment
   * requirement. The gateway then signs `typedData` with its `Signer`,
   * combines the signature with `authorization`, and base64-encodes the
   * result into the v1 X-PAYMENT (or v2 PAYMENT-SIGNATURE) header.
   */
  buildPayment(
    reqs: PaymentRequirements,
    payerAddress: Address,
  ): { typedData: Eip712TypedData; authorization: Authorization };
}

export interface SolanaChainAdapter extends ChainAdapterBase {
  readonly kind: 'svm';
  /**
   * Build a partially-signed Solana transaction for the payment. Returns
   * the unsigned tx with the seller-provided feePayer already set; the
   * gateway's SolanaSigner adds the buyer's signature and the result is
   * base64-encoded into the v2 `payload.transaction` field.
   *
   * Async because ATA derivation can require an RPC roundtrip in some
   * implementations (this one derives PDAs synchronously, but keeping the
   * shape async leaves room for future RPC-backed lookups).
   */
  buildPayment(
    reqs: PaymentRequirements,
    payerPubkey: string,
  ): Promise<{ tx: VersionedTransaction }>;
}

export type ChainAdapter = EvmChainAdapter | SolanaChainAdapter;
