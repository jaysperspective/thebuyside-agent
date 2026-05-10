/**
 * EnvKeySigner — backs the Signer interface with a private key loaded from
 * the environment (X402_PAYER_PRIVATE_KEY). Single-line implementation
 * over viem's `privateKeyToAccount`.
 *
 * Security note: the key is held in process memory for the lifetime of the
 * gateway. v0 trusts the local OS / file permissions on `.env`. Production
 * deployments should swap in a KMS-backed signer.
 */

import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Eip712TypedData, EvmSigner } from './signer.js';

export class EnvKeySigner implements EvmSigner {
  readonly kind = 'evm' as const;
  readonly address: Address;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  async signTypedData(typedData: Eip712TypedData): Promise<Hex> {
    // viem's signTypedData accepts the same shape (domain, types, primaryType,
    // message). The cast keeps our interface decoupled from viem's strict generics.
    return this.account.signTypedData(typedData as Parameters<typeof this.account.signTypedData>[0]);
  }
}
