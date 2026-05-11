/**
 * MPP client round-trip tests — challenge parsing, credential building,
 * gateway hook wiring, and failure modes. Uses an in-memory fetch mock plus
 * a real Solana keypair so the signature path is exercised end-to-end.
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { SolanaUsdcAdapter } from '../src/chains/solana-usdc.js';
import { payAndFetchMpp } from '../src/mpp/client.js';
import { decodeJcsBase64Url, jcsBase64Url } from '../src/mpp/jcs.js';
import type { ChargeRequest, Credential, PaymentReceipt } from '../src/mpp/types.js';
import { USDC_MAINNET_MINT } from '../src/mpp/types.js';
import { EnvSolanaKeySigner } from '../src/signer/env-solana-key.js';

const BUYER = Keypair.fromSeed(Buffer.alloc(32, 1));
const SELLER = Keypair.fromSeed(Buffer.alloc(32, 2));
const FACILITATOR = Keypair.fromSeed(Buffer.alloc(32, 3));

const STUB_BLOCKHASH = bs58.encode(Buffer.alloc(32, 9));
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function buyerSigner(): EnvSolanaKeySigner {
  return new EnvSolanaKeySigner(bs58.encode(BUYER.secretKey));
}

function makeCharge(overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    amount: '5000',
    currency: USDC_MAINNET_MINT,
    recipient: SELLER.publicKey.toBase58(),
    description: 'unit test',
    methodDetails: {
      decimals: 6,
      feePayer: true,
      feePayerKey: FACILITATOR.publicKey.toBase58(),
      network: 'mainnet',
      recentBlockhash: STUB_BLOCKHASH,
      tokenProgram: TOKEN_PROGRAM,
    },
    ...overrides,
  };
}

function make402(
  charge: ChargeRequest,
  opts: { id?: string; expires?: string; description?: string } = {},
): Response {
  const id = opts.id ?? 'challenge-id-1';
  const expires = opts.expires ?? new Date(Date.now() + 60_000).toISOString();
  const requestB64 = jcsBase64Url(charge);
  const description = opts.description ?? charge.description ?? '';
  const header =
    `Payment id="${id}", realm="example.test", method="solana", ` +
    `intent="charge", request="${requestB64}"` +
    (description ? `, description="${description}"` : '') +
    `, expires="${expires}"`;
  return new Response(
    JSON.stringify({
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      challengeId: id,
    }),
    {
      status: 402,
      headers: {
        'content-type': 'application/problem+json',
        'www-authenticate': header,
      },
    },
  );
}

function make200(receipt: PaymentReceipt | null, body: unknown): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (receipt) headers['payment-receipt'] = jcsBase64Url(receipt);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

type Call = { url: string; init?: RequestInit };

function makeMockFetch(responses: Response[]): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const resp = responses[i++];
    if (!resp) throw new Error(`mockFetch: out of responses (call ${i})`);
    return resp;
  };
  return { fetchFn, calls };
}

describe('payAndFetchMpp — happy path', () => {
  it('parses challenge, signs tx, sends Authorization, captures receipt', async () => {
    const charge = makeCharge();
    const receipt: PaymentReceipt = {
      amount: '1000',
      challengeId: 'challenge-id-1',
      currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      network: 'mainnet',
      recipient: 'CNkB2jCHvnjF6zzmK2QeL9qEWBcq2oSq5t1DBnD59yJj',
      settledAt: new Date().toISOString(),
      slot: 123456789,
      source: 'payer-pubkey',
      txSignature: 'tx-signature-abc',
    };
    const { fetchFn, calls } = makeMockFetch([
      make402(charge),
      make200(receipt, { ok: true, data: 'payload' }),
    ]);

    const result = await payAndFetchMpp({
      url: 'https://example.test/api',
      signer: buyerSigner(),
      adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
      fetchFn,
    });

    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ ok: true, data: 'payload' });
    expect(result.settledTx).toBe('tx-signature-abc');
    expect(result.paidCharge?.amount).toBe('5000');

    expect(calls).toHaveLength(2);
    const auth = (calls[1].init?.headers as Record<string, string>)?.authorization;
    expect(auth).toMatch(/^Payment /);

    const credential = decodeJcsBase64Url(auth!.slice('Payment '.length)) as Credential;
    expect(credential.challenge.id).toBe('challenge-id-1');
    expect(credential.source).toBe(BUYER.publicKey.toBase58());
    expect(credential.payload.type).toBe('transaction');
    // The buyer signed a parseable VersionedTransaction.
    const tx = VersionedTransaction.deserialize(
      Buffer.from(credential.payload.transaction, 'base64'),
    );
    expect(tx.signatures.length).toBeGreaterThan(0);
  });
});

describe('payAndFetchMpp — guards', () => {
  it('rejects a 402 without an MPP WWW-Authenticate header', async () => {
    const { fetchFn } = makeMockFetch([
      new Response('{}', { status: 402, headers: { 'content-type': 'application/json' } }),
    ]);
    await expect(
      payAndFetchMpp({
        url: 'https://example.test/api',
        signer: buyerSigner(),
        adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
        fetchFn,
      }),
    ).rejects.toThrow(/did not advertise an MPP/);
  });

  it('rejects a non-USDC currency', async () => {
    const charge = makeCharge({ currency: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' });
    const { fetchFn } = makeMockFetch([make402(charge)]);
    await expect(
      payAndFetchMpp({
        url: 'https://example.test/api',
        signer: buyerSigner(),
        adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
        fetchFn,
      }),
    ).rejects.toThrow(/not supported.*USDC mainnet mint/);
  });

  it('rejects a localnet challenge by default', async () => {
    const charge = makeCharge({
      methodDetails: { ...makeCharge().methodDetails, network: 'localnet' },
    });
    const { fetchFn } = makeMockFetch([make402(charge)]);
    await expect(
      payAndFetchMpp({
        url: 'https://example.test/api',
        signer: buyerSigner(),
        adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
        fetchFn,
      }),
    ).rejects.toThrow(/network=localnet rejected/);
  });

  it('accepts a localnet challenge when allowNonMainnet is set', async () => {
    const charge = makeCharge({
      methodDetails: { ...makeCharge().methodDetails, network: 'localnet' },
    });
    const { fetchFn } = makeMockFetch([
      make402(charge),
      make200(null, { ok: true }),
    ]);
    const result = await payAndFetchMpp({
      url: 'https://example.test/api',
      signer: buyerSigner(),
      adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
      fetchFn,
      allowNonMainnet: true,
    });
    expect(result.paid).toBe(true);
  });

  it('rejects an expired challenge', async () => {
    const charge = makeCharge();
    const past = new Date(Date.now() - 60_000).toISOString();
    const { fetchFn } = makeMockFetch([make402(charge, { expires: past })]);
    await expect(
      payAndFetchMpp({
        url: 'https://example.test/api',
        signer: buyerSigner(),
        adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
        fetchFn,
      }),
    ).rejects.toThrow(/already expired/);
  });

  it('rejects when buyer pubkey equals recipient (self-pay)', async () => {
    const charge = makeCharge({ recipient: BUYER.publicKey.toBase58() });
    const { fetchFn } = makeMockFetch([make402(charge)]);
    await expect(
      payAndFetchMpp({
        url: 'https://example.test/api',
        signer: buyerSigner(),
        adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
        fetchFn,
      }),
    ).rejects.toThrow(/cannot pay yourself/);
  });
});

describe('payAndFetchMpp — hooks', () => {
  it('invokes beforePay before signing and aborts on throw', async () => {
    const charge = makeCharge();
    const { fetchFn, calls } = makeMockFetch([make402(charge)]);
    let beforeCalled = false;
    await expect(
      payAndFetchMpp({
        url: 'https://example.test/api',
        signer: buyerSigner(),
        adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
        fetchFn,
        beforePay: async () => {
          beforeCalled = true;
          throw new Error('caps exceeded');
        },
      }),
    ).rejects.toThrow(/caps exceeded/);
    expect(beforeCalled).toBe(true);
    // Only the initial GET should have happened; no retry with payment.
    expect(calls).toHaveLength(1);
  });

  it('invokes onPaid with the tx hash on 200', async () => {
    const charge = makeCharge();
    const receipt: PaymentReceipt = {
      amount: '1000',
      challengeId: 'challenge-id-1',
      currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      network: 'mainnet',
      recipient: 'CNkB2jCHvnjF6zzmK2QeL9qEWBcq2oSq5t1DBnD59yJj',
      settledAt: new Date().toISOString(),
      slot: 123456789,
      source: 'payer-pubkey',
      txSignature: 'tx-sig-xyz',
    };
    const { fetchFn } = makeMockFetch([
      make402(charge),
      make200(receipt, { ok: true }),
    ]);
    let recorded: { amount: string; tx: string | undefined } | null = null;
    await payAndFetchMpp({
      url: 'https://example.test/api',
      signer: buyerSigner(),
      adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
      fetchFn,
      onPaid: async ({ charge: c, tx }) => {
        recorded = { amount: c.amount, tx };
      },
    });
    expect(recorded).toEqual({ amount: '5000', tx: 'tx-sig-xyz' });
  });
});

describe('payAndFetchMpp — failure path', () => {
  it('returns failure diagnostics on non-200 retry', async () => {
    const charge = makeCharge();
    const { fetchFn } = makeMockFetch([
      make402(charge),
      new Response('{"error":"insufficient funds"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const result = await payAndFetchMpp({
      url: 'https://example.test/api',
      signer: buyerSigner(),
      adapter: new SolanaUsdcAdapter({ blockhashFetcher: async () => STUB_BLOCKHASH }),
      fetchFn,
    });
    expect(result.paid).toBe(false);
    expect(result.status).toBe(500);
    expect(result.failure?.body).toEqual({ error: 'insufficient funds' });
  });
});
