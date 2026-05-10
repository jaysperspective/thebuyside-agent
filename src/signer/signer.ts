/**
 * Signer interface — abstracts "produce a signature for an x402 payment."
 *
 * Discriminated union by chain kind. EVM signs EIP-712 typed data and
 * returns a hex signature; SVM (Solana) signs a partially-built
 * VersionedTransaction in place and returns the same tx with the buyer's
 * signature attached. Same `kind` discriminator as ChainAdapter so the
 * protocol loop pairs them by branching once.
 *
 * The hosted-product path will add a KMS-backed sibling for each kind
 * (KmsEvmSigner / KmsSolanaSigner) that delegates signing to a managed
 * key service without the gateway ever seeing raw key material.
 */

import type { VersionedTransaction } from '@solana/web3.js';
import type { Address, Hex } from 'viem';

export type Eip712TypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export interface EvmSigner {
  readonly kind: 'evm';
  readonly address: Address;
  signTypedData(typedData: Eip712TypedData): Promise<Hex>;
}

export interface SolanaSigner {
  readonly kind: 'svm';
  /** Base58-encoded public key. */
  readonly publicKey: string;
  /**
   * Add the buyer's signature to a versioned tx. The seller's feePayer
   * slot is left untouched — the facilitator counter-signs and broadcasts.
   * Returns the same tx instance with the signature attached.
   */
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

export type Signer = EvmSigner | SolanaSigner;
