/**
 * Signer interface — abstracts "produce an EIP-712 signature for typed data".
 *
 * v0 has one implementation: `EnvKeySigner` (BYO private key from env). The
 * hosted-product path will add a `KmsSigner` that delegates signing to a
 * managed key service (AWS KMS, Coinbase CDP-managed wallets, etc.) without
 * the gateway ever seeing raw key material.
 *
 * Note: this interface is EVM-shaped (EIP-712 typed data). When we add a
 * non-EVM chain (Solana via Pay.sh in v0.2), we'll either widen this interface
 * or introduce a sibling `SolanaSigner`. Both are clean refactors from here.
 */

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

export interface Signer {
  readonly address: Address;
  signTypedData(typedData: Eip712TypedData): Promise<Hex>;
}
