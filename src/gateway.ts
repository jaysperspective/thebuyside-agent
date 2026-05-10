/**
 * Gateway — the bundle of components every MCP tool needs.
 *
 * Built once at server startup and passed by reference to each tool's
 * register function. Keeps tool signatures stable as we add modules
 * (analytics, hosted-wallet, multi-chain, etc.) over time.
 *
 * Multi-chain (M8): the gateway holds at most one signer per chain
 * kind (`evm`, `svm`). Either, both, or neither may be configured —
 * the tools error clearly when an MCP call would need a signer that
 * isn't set.
 */

import { BaseUsdcAdapter } from './chains/base-usdc.js';
import { SolanaUsdcAdapter } from './chains/solana-usdc.js';
import type { ChainAdapter } from './chains/adapter.js';
import type { Config } from './config.js';
import { Allowlist } from './policy/allowlist.js';
import { CapPolicy } from './policy/caps.js';
import { ConfirmPolicy } from './policy/confirm.js';
import { Receipts } from './policy/receipts.js';
import { Federation } from './registry/federation.js';
import { Registry } from './registry/lookup.js';
import { EnvKeySigner } from './signer/env-key.js';
import { EnvSolanaKeySigner } from './signer/env-solana-key.js';
import type { EvmSigner, SolanaSigner } from './signer/signer.js';

export type Signers = {
  evm: EvmSigner | null;
  svm: SolanaSigner | null;
};

export type Gateway = {
  signers: Signers;
  chains: ChainAdapter[];
  allowlist: Allowlist;
  receipts: Receipts;
  caps: CapPolicy;
  confirm: ConfirmPolicy;
  registry: Registry;
  federation: Federation;
};

export async function buildGateway(config: Config): Promise<Gateway> {
  const receipts = Receipts.fromEnv();
  const registry = await Registry.load();

  const signers: Signers = {
    evm: config.payerPrivateKey ? new EnvKeySigner(config.payerPrivateKey) : null,
    svm: config.payerSolanaKey ? new EnvSolanaKeySigner(config.payerSolanaKey) : null,
  };

  return {
    signers,
    chains: [new BaseUsdcAdapter(), new SolanaUsdcAdapter()],
    allowlist: Allowlist.fromEnv({ defaultHosts: registry.hosts() }),
    receipts,
    caps: CapPolicy.fromEnv(receipts),
    confirm: ConfirmPolicy.fromEnv(),
    registry,
    federation: Federation.fromEnv(),
  };
}

/** True if at least one chain has a configured signer. */
export function hasAnySigner(s: Signers): boolean {
  return s.evm !== null || s.svm !== null;
}
