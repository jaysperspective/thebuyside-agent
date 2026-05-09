/**
 * M0 — Standalone x402 payment smoke test against news-ep.com.
 *
 * Drives the full x402 v1 loop end-to-end:
 *   1. GET the priced endpoint with no payment header → expect 402
 *   2. Parse the challenge (the `accepts` array tells us price, payTo, asset)
 *   3. Build an EIP-3009 `transferWithAuthorization` typed-data payload
 *   4. Sign it with the wallet key from `.env`
 *   5. Base64-encode the signed authorization into an `X-PAYMENT` header
 *   6. Re-GET with the header → expect 200 with the article body
 *
 * No MCP yet. No SDK shortcuts. Pure viem + fetch so we own every line of
 * the protocol logic — this code is the seed for `src/x402/client.ts` in M2.
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { Hex } from 'viem';

// ----- Config -----

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

// ----- x402 v1 challenge shape (subset we care about) -----

type PaymentRequirements = {
  scheme: 'exact';
  // Some servers emit "base" / "base-sepolia"; others emit "eip155:8453".
  network: string;
  // USDC atomic units (6 decimals). E.g. "5000" = $0.005.
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: Hex;
  maxTimeoutSeconds: number;
  // The ERC-20 contract address (USDC on Base is 0x833589…).
  asset: Hex;
  // EIP-712 domain name + version for the asset's `transferWithAuthorization`.
  // Critical: Base mainnet USDC's domain name is "USD Coin" (NOT "USDC").
  extra: { name: string; version: string };
};

type Challenge = {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
};

// ----- M0 main -----

async function main(): Promise<void> {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  console.log(`payer: ${account.address}`);
  console.log(`target: ${TEST_URL}`);

  // 1) Initial unpaid request — expect 402.
  console.log('\n→ GET (no payment)');
  const r1 = await fetch(TEST_URL);
  if (r1.status !== 402) {
    console.error(`  expected 402, got ${r1.status}: ${await r1.text()}`);
    process.exit(1);
  }
  const challenge = (await r1.json()) as Challenge;

  const reqs = challenge.accepts.find(
    (a) =>
      a.scheme === 'exact' &&
      (a.network === 'base' || a.network === 'eip155:8453'),
  );
  if (!reqs) {
    console.error(
      '  no Base-mainnet `exact` payment option in challenge:',
      JSON.stringify(challenge, null, 2),
    );
    process.exit(1);
  }
  console.log(
    `  402 received. price: ${reqs.maxAmountRequired} atomic ` +
      `($${(Number(reqs.maxAmountRequired) / 1e6).toFixed(6)} USDC), payTo: ${reqs.payTo}`,
  );

  // 2) Build the EIP-3009 transferWithAuthorization typed-data payload.
  //    EIP-3009 is the USDC standard that lets a payer sign an off-chain
  //    authorization which a third party (the facilitator) can submit to
  //    move tokens. The facilitator covers gas — the payer never broadcasts.
  const validAfter = 0n;
  const validBefore = BigInt(
    Math.floor(Date.now() / 1000) + reqs.maxTimeoutSeconds,
  );
  const nonce = (`0x${randomBytes(32).toString('hex')}`) as Hex;

  const typedData = {
    domain: {
      name: reqs.extra.name, // "USD Coin" on Base mainnet
      version: reqs.extra.version, // "2"
      chainId: base.id, // 8453
      verifyingContract: reqs.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: reqs.payTo,
      value: BigInt(reqs.maxAmountRequired),
      validAfter,
      validBefore,
      nonce,
    },
  } as const;

  console.log('→ signing EIP-3009 transferWithAuthorization');
  const signature = await account.signTypedData(typedData);
  console.log(`  signature: ${signature.slice(0, 18)}…`);

  // 3) Build the X-PAYMENT header — base64(JSON of the signed authorization).
  //    Numeric fields are sent as decimal strings to avoid JS bigint issues.
  const paymentPayload = {
    x402Version: challenge.x402Version,
    scheme: reqs.scheme,
    network: reqs.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: reqs.payTo,
        value: reqs.maxAmountRequired,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // 4) Re-request with the payment header. The server's middleware verifies
  //    the signature, asks the facilitator to settle, and returns the resource.
  console.log('→ GET (with X-PAYMENT)');
  const r2 = await fetch(TEST_URL, { headers: { 'X-PAYMENT': xPayment } });
  console.log(`  status: ${r2.status}`);

  // The CDP facilitator currently doesn't always emit X-PAYMENT-RESPONSE
  // with the settle tx hash — that's a known cosmetic quirk. Don't fail on it.
  const xPaymentResponse = r2.headers.get('x-payment-response');
  if (xPaymentResponse) {
    try {
      const decoded = JSON.parse(
        Buffer.from(xPaymentResponse, 'base64').toString('utf8'),
      );
      console.log(`  settled tx: ${decoded.transaction ?? '(field missing)'}`);
    } catch {
      console.log(`  X-PAYMENT-RESPONSE: ${xPaymentResponse}`);
    }
  } else {
    console.log(
      '  (no X-PAYMENT-RESPONSE header — known CDP middleware quirk; ' +
        'verify on https://basescan.org if needed)',
    );
  }

  if (r2.status !== 200) {
    console.error(`✗ paid request failed: ${await r2.text()}`);
    process.exit(1);
  }

  const body = await r2.json();
  console.log('\n--- response body ---');
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err: unknown) => {
  console.error('\n✗ M0 failed:', err);
  process.exit(1);
});
