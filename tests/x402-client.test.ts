/**
 * Unit tests for `payAndFetch`. Uses an in-memory fetch mock — no network,
 * no real signing keys outside a deterministic test key.
 */

import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { BaseUsdcAdapter } from '../src/chains/base-usdc.js';
import { EnvKeySigner } from '../src/signer/env-key.js';
import { payAndFetch } from '../src/x402/client.js';

const TEST_KEY: Hex =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const NEWSEP_402_BODY = {
  x402Version: 1,
  error: 'X-PAYMENT header is required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '5000',
      resource: 'https://example.test/api',
      description: 'test resource',
      payTo: '0xc8CaE186fb4f382D3DD9C82cbA976C255531540C',
      maxTimeoutSeconds: 60,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

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

describe('payAndFetch', () => {
  it('handles 402 → sign → 200 round trip with correct X-PAYMENT header', async () => {
    const { fetchFn, calls } = makeMockFetch([
      new Response(JSON.stringify(NEWSEP_402_BODY), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ ok: true, data: 'payload' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const signer = new EnvKeySigner(TEST_KEY);
    const result = await payAndFetch({
      url: 'https://example.test/api',
      signer,
      chains: [new BaseUsdcAdapter()],
      fetchFn,
    });

    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ ok: true, data: 'payload' });
    expect(calls).toHaveLength(2);

    // First call: no X-PAYMENT header
    const headers1 = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers1['X-PAYMENT']).toBeUndefined();

    // Second call: X-PAYMENT header is base64 JSON of the signed authorization
    const headers2 = (calls[1].init?.headers ?? {}) as Record<string, string>;
    expect(headers2['X-PAYMENT']).toBeDefined();

    const decoded = JSON.parse(
      Buffer.from(headers2['X-PAYMENT'], 'base64').toString('utf8'),
    );
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('base');
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(decoded.payload.authorization.from).toBe(signer.address);
    expect(decoded.payload.authorization.to).toBe(
      '0xc8CaE186fb4f382D3DD9C82cbA976C255531540C',
    );
    expect(decoded.payload.authorization.value).toBe('5000');
    expect(decoded.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('passes through a non-402 response without payment', async () => {
    const { fetchFn, calls } = makeMockFetch([
      new Response(JSON.stringify({ free: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const result = await payAndFetch({
      url: 'https://example.test/free',
      signer: new EnvKeySigner(TEST_KEY),
      chains: [new BaseUsdcAdapter()],
      fetchFn,
    });

    expect(result.status).toBe(200);
    expect(result.paid).toBe(false);
    expect(result.body).toEqual({ free: true });
    expect(calls).toHaveLength(1);
  });

  it('throws when no chain adapter matches the offered network', async () => {
    const { fetchFn } = makeMockFetch([
      new Response(
        JSON.stringify({
          ...NEWSEP_402_BODY,
          accepts: [{ ...NEWSEP_402_BODY.accepts[0], network: 'solana' }],
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    ]);

    await expect(
      payAndFetch({
        url: 'https://example.test/api',
        signer: new EnvKeySigner(TEST_KEY),
        chains: [new BaseUsdcAdapter()],
        fetchFn,
      }),
    ).rejects.toThrow(/no chain adapter/);
  });

  it('extracts settle tx hash from X-PAYMENT-RESPONSE if present', async () => {
    const settleHeader = Buffer.from(
      JSON.stringify({ transaction: '0xdeadbeef' }),
    ).toString('base64');

    const { fetchFn } = makeMockFetch([
      new Response(JSON.stringify(NEWSEP_402_BODY), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-payment-response': settleHeader,
        },
      }),
    ]);

    const result = await payAndFetch({
      url: 'https://example.test/api',
      signer: new EnvKeySigner(TEST_KEY),
      chains: [new BaseUsdcAdapter()],
      fetchFn,
    });

    expect(result.settledTx).toBe('0xdeadbeef');
  });

  it('tolerates missing X-PAYMENT-RESPONSE (CDP facilitator quirk)', async () => {
    const { fetchFn } = makeMockFetch([
      new Response(JSON.stringify(NEWSEP_402_BODY), { status: 402 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const result = await payAndFetch({
      url: 'https://example.test/api',
      signer: new EnvKeySigner(TEST_KEY),
      chains: [new BaseUsdcAdapter()],
      fetchFn,
    });

    expect(result.paid).toBe(true);
    expect(result.settledTx).toBeUndefined();
  });
});
