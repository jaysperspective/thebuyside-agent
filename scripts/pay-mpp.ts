/**
 * Standalone MPP (Machine Payments Protocol) live test.
 *
 * Mirrors `pay-solana.ts` for the MPP path: thin wrapper around
 * `payAndFetchMpp` that registers a Solana signer + adapter and hits a URL
 * expected to return a 402 with a `WWW-Authenticate: Payment ...` header.
 *
 * Default target is news-ep.com's get-story endpoint ($0.001 USDC) once
 * `mpp_mode=active` is flipped on the seller side. Override with
 * X402_TEST_MPP_URL.
 *
 * Useful for two phases:
 *   1. Pre-verify: news-ep's verify-and-broadcast is stubbed today, so the
 *      run will end at a 402 with `detail: "verification not yet enabled"`
 *      after we send our credential. That still exercises the full wire
 *      surface (auth-header parsing, JCS encoding, replay protection on
 *      the seller side) and is the right pre-launch smoke test.
 *   2. Post-verify: same script, real settlement, real tx signature.
 *
 * Run: pnpm pay-mpp
 * Debug bytes:  X402_MPP_DEBUG=1 pnpm pay-mpp
 * Sandbox:      X402_MPP_ALLOW_NON_MAINNET=1 pnpm pay-mpp
 */

import 'dotenv/config';
import { SolanaUsdcAdapter } from '../src/chains/solana-usdc.js';
import { payAndFetchMpp } from '../src/mpp/client.js';
import { EnvSolanaKeySigner } from '../src/signer/env-solana-key.js';

const TEST_URL =
  process.env.X402_TEST_MPP_URL ?? 'https://news-ep.com/api/v1/stories/78042';
const ALLOW_NON_MAINNET = process.env.X402_MPP_ALLOW_NON_MAINNET === '1';

const SOLANA_KEY = process.env.X402_PAYER_SOLANA_KEY;
if (!SOLANA_KEY) {
  console.error(
    '✗ Missing X402_PAYER_SOLANA_KEY.\n' +
      '  Export the secret key from your test Solana wallet (Phantom: Show Private Key)\n' +
      '  and paste the base58 string into .env.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const signer = new EnvSolanaKeySigner(SOLANA_KEY!);
  console.log(`payer:    ${signer.publicKey}`);
  console.log(`target:   ${TEST_URL}`);
  if (ALLOW_NON_MAINNET) console.log(`network:  non-mainnet allowed (sandbox mode)`);
  console.log();

  const result = await payAndFetchMpp({
    url: TEST_URL,
    signer,
    adapter: new SolanaUsdcAdapter(),
    allowNonMainnet: ALLOW_NON_MAINNET,
  });

  console.log(`status:   ${result.status}`);
  if (result.paidCharge) {
    const c = result.paidCharge;
    const usdc = (Number(c.amount) / 1e6).toFixed(6);
    console.log(`amount:   ${c.amount} atomic ($${usdc} USDC)`);
    console.log(`to:       ${c.recipient}`);
    console.log(`network:  ${c.methodDetails.network}`);
    if (c.description) console.log(`for:      ${c.description}`);
  }
  console.log(`paid:     ${result.paid}`);

  if (result.paid && result.settledTx) {
    console.log(`tx:       ${result.settledTx}`);
    console.log(`          https://solscan.io/tx/${result.settledTx}`);
  } else if (result.paid) {
    console.log('tx:       (no Payment-Receipt header)');
  }

  if (result.status !== 200) {
    console.error('\n✗ paid request did not return 200');
    if (result.failure) {
      console.error(JSON.stringify(result.failure.body, null, 2));
    } else {
      console.error(JSON.stringify(result.body, null, 2));
    }
    process.exit(1);
  }

  console.log('\nbody (truncated):');
  const bodyStr = JSON.stringify(result.body);
  console.log(bodyStr.length > 500 ? bodyStr.slice(0, 500) + '…' : bodyStr);
}

main().catch((err: unknown) => {
  console.error('\n✗ pay-mpp failed:', err);
  process.exit(1);
});
