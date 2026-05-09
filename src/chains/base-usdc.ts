/**
 * BaseUsdcAdapter — Base mainnet, USDC-as-asset, EIP-3009 transferWithAuthorization.
 *
 * Behaviour matches what news-ep.com expects: `network` of either "base" or
 * "eip155:8453"; EIP-712 domain name "USD Coin" / version "2" (provided by
 * the `extra` field of the 402 challenge — we don't hardcode these because
 * different USDC deployments use different domain names, e.g. Base Sepolia
 * uses "USDC").
 */

import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { base } from 'viem/chains';
import type { Eip712TypedData } from '../signer/signer.js';
import type { Authorization, PaymentRequirements } from '../x402/types.js';
import type { ChainAdapter } from './adapter.js';

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export class BaseUsdcAdapter implements ChainAdapter {
  readonly id = 'base';

  matches(network: string): boolean {
    return network === 'base' || network === 'eip155:8453';
  }

  buildPayment(
    reqs: PaymentRequirements,
    payerAddress: Address,
  ): { typedData: Eip712TypedData; authorization: Authorization } {
    const validAfter = 0n;
    const validBefore = BigInt(
      Math.floor(Date.now() / 1000) + reqs.maxTimeoutSeconds,
    );
    const nonce = `0x${randomBytes(32).toString('hex')}` as Hex;

    const typedData: Eip712TypedData = {
      domain: {
        name: reqs.extra.name,
        version: reqs.extra.version,
        chainId: base.id,
        verifyingContract: reqs.asset,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payerAddress,
        to: reqs.payTo,
        value: BigInt(reqs.maxAmountRequired),
        validAfter,
        validBefore,
        nonce,
      },
    };

    const authorization: Authorization = {
      from: payerAddress,
      to: reqs.payTo,
      value: reqs.maxAmountRequired,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };

    return { typedData, authorization };
  }
}
