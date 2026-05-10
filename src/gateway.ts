/**
 * Gateway — the bundle of components every MCP tool needs.
 *
 * Built once at server startup and passed by reference to each tool's
 * register function. Keeps tool signatures stable as we add modules
 * (analytics, hosted-wallet, multi-chain, etc.) over time.
 */

import { BaseUsdcAdapter } from './chains/base-usdc.js';
import type { ChainAdapter } from './chains/adapter.js';
import type { Config } from './config.js';
import { Allowlist } from './policy/allowlist.js';
import { CapPolicy } from './policy/caps.js';
import { Receipts } from './policy/receipts.js';
import { Registry } from './registry/lookup.js';
import { EnvKeySigner } from './signer/env-key.js';
import type { Signer } from './signer/signer.js';

export type Gateway = {
  signer: Signer | null;
  chains: ChainAdapter[];
  allowlist: Allowlist;
  receipts: Receipts;
  caps: CapPolicy;
  registry: Registry;
};

export async function buildGateway(config: Config): Promise<Gateway> {
  const receipts = Receipts.fromEnv();
  const registry = await Registry.load();

  return {
    signer: config.payerPrivateKey ? new EnvKeySigner(config.payerPrivateKey) : null,
    chains: [new BaseUsdcAdapter()],
    allowlist: Allowlist.fromEnv({ defaultHosts: registry.hosts() }),
    receipts,
    caps: CapPolicy.fromEnv(receipts),
    registry,
  };
}
