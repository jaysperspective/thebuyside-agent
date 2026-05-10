/**
 * Standalone Solana x402 live test.
 *
 * Mirrors `pay-newsep.ts` for the Solana side: thin wrapper around
 * `payAndFetch` that registers ONLY the Solana adapter + signer, so
 * even when the seller offers multiple chains the gateway is forced
 * down the SVM path.
 *
 * Default target is x402.ottoai.services/crypto-news ($0.001 USDC),
 * a known live Solana x402 endpoint that emits a clean v2 challenge.
 * Override with X402_TEST_URL.
 *
 * Run: pnpm pay-solana
 */

import 'dotenv/config';
import { SolanaUsdcAdapter } from '../src/chains/solana-usdc.js';
import { EnvSolanaKeySigner } from '../src/signer/env-solana-key.js';
import { payAndFetch } from '../src/x402/client.js';

const TEST_URL =
  process.env.X402_TEST_URL ?? 'https://x402.ottoai.services/crypto-news';

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
  console.log(`payer:  ${signer.publicKey}`);
  console.log(`target: ${TEST_URL}\n`);

  const result = await payAndFetch({
    url: TEST_URL,
    signers: { evm: null, svm: signer },
    chains: [new SolanaUsdcAdapter()],
  });

  console.log(`status: ${result.status}`);
  if (result.paid) {
    const reqs = result.paidRequirements!;
    const usdc = (Number(reqs.maxAmountRequired) / 1e6).toFixed(6);
    console.log(
      `paid:   ${reqs.maxAmountRequired} atomic ($${usdc} USDC) → ${reqs.payTo}`,
    );
    if (result.settledTx) {
      console.log(`tx:     ${result.settledTx}`);
      console.log(`        https://solscan.io/tx/${result.settledTx}`);
    } else {
      console.log('tx:     (no PAYMENT-RESPONSE header — verify on solscan.io)');
    }
  }

  if (result.status !== 200) {
    console.error('\n✗ paid request failed');
    if (result.failureDiagnostics) {
      console.error('headers:', result.failureDiagnostics.headers);
      console.error(
        'paymentRequired:',
        JSON.stringify(result.failureDiagnostics.paymentRequired, null, 2),
      );
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
  console.error('\n✗ pay-solana failed:', err);
  process.exit(1);
});
