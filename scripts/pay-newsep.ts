/**
 * M0 — Standalone x402 payment smoke test against news-ep.com.
 *
 * As of M2a, this script is a thin wrapper around `payAndFetch` from the
 * gateway core. The protocol logic now lives in `src/x402/client.ts`,
 * `src/signer/`, and `src/chains/`. This script just loads the wallet key,
 * configures Base USDC, and prints the result.
 *
 * Run: pnpm pay-newsep
 */

import 'dotenv/config';
import type { Hex } from 'viem';
import { BaseUsdcAdapter } from '../src/chains/base-usdc.js';
import { EnvKeySigner } from '../src/signer/env-key.js';
import { payAndFetch } from '../src/x402/client.js';

const TEST_URL =
  process.env.X402_TEST_URL ??
  'https://news-ep.com/api/v1/stories?market=dmv&limit=1';

const PRIVATE_KEY = process.env.X402_PAYER_PRIVATE_KEY as Hex | undefined;

if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith('0x') || PRIVATE_KEY.length !== 66) {
  console.error(
    '✗ Missing or invalid X402_PAYER_PRIVATE_KEY.\n' +
      '  Copy .env.example to .env and paste a 0x-prefixed private key (64 hex chars).',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const signer = new EnvKeySigner(PRIVATE_KEY!);
  console.log(`payer:  ${signer.address}`);
  console.log(`target: ${TEST_URL}\n`);

  const result = await payAndFetch({
    url: TEST_URL,
    signer,
    chains: [new BaseUsdcAdapter()],
  });

  console.log(`status: ${result.status}`);
  if (result.paid) {
    const reqs = result.paidRequirements!;
    console.log(
      `paid:   ${reqs.maxAmountRequired} atomic ` +
        `($${(Number(reqs.maxAmountRequired) / 1e6).toFixed(6)} USDC) → ${reqs.payTo}`,
    );
    if (result.settledTx) {
      console.log(`tx:     ${result.settledTx}`);
    } else {
      console.log('tx:     (no X-PAYMENT-RESPONSE header — verify on basescan.org)');
    }
  }

  if (result.status !== 200) {
    console.error('\n✗ paid request failed');
    console.error(JSON.stringify(result.body, null, 2));
    process.exit(1);
  }

  console.log('\n--- response body ---');
  console.log(JSON.stringify(result.body, null, 2));
}

main().catch((err: unknown) => {
  console.error('\n✗ pay-newsep failed:', err);
  process.exit(1);
});
