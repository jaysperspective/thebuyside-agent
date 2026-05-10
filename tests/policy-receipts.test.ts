import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Receipts } from '../src/policy/receipts.js';

describe('Receipts', () => {
  let dir: string;
  let receipts: Receipts;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tbs-receipts-'));
    receipts = new Receipts(join(dir, 'receipts.jsonl'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', async () => {
    expect(await receipts.list()).toEqual([]);
    expect(await receipts.spentSinceHours(24)).toBe(0n);
  });

  it('records a receipt and reads it back', async () => {
    const r = await receipts.record({
      host: 'news-ep.com',
      url: 'https://news-ep.com/api/v1/stories',
      method: 'GET',
      amount_atomic: '5000',
      asset: 'USDC',
      chain: 'base',
      tx_hash: '0xabcd',
    });

    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const all = await receipts.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(r);
  });

  it('sums atomic amounts across multiple records', async () => {
    await receipts.record({
      host: 'a',
      url: 'a',
      method: 'GET',
      amount_atomic: '5000',
      asset: 'USDC',
      chain: 'base',
      tx_hash: null,
    });
    await receipts.record({
      host: 'b',
      url: 'b',
      method: 'GET',
      amount_atomic: '3500',
      asset: 'USDC',
      chain: 'base',
      tx_hash: null,
    });

    expect(await receipts.spentSinceHours(24)).toBe(8500n);
  });

  it('excludes receipts older than the window', async () => {
    // Inject an old receipt manually by writing the file directly.
    const oldTs = new Date(Date.now() - 48 * 3600_000).toISOString();
    await writeFile(
      receipts.filepath,
      JSON.stringify({
        id: 'old-1',
        ts: oldTs,
        host: 'old',
        url: 'old',
        method: 'GET',
        amount_atomic: '99000',
        asset: 'USDC',
        chain: 'base',
        tx_hash: null,
      }) + '\n',
    );

    await receipts.record({
      host: 'new',
      url: 'new',
      method: 'GET',
      amount_atomic: '5000',
      asset: 'USDC',
      chain: 'base',
      tx_hash: null,
    });

    expect(await receipts.spentSinceHours(24)).toBe(5000n);
    expect(await receipts.list()).toHaveLength(2); // list returns everything
  });

  it('skips malformed lines without throwing', async () => {
    await writeFile(
      receipts.filepath,
      'not-json\n' +
        JSON.stringify({
          id: '1',
          ts: new Date().toISOString(),
          host: 'a',
          url: 'a',
          method: 'GET',
          amount_atomic: '1000',
          asset: 'USDC',
          chain: 'base',
          tx_hash: null,
        }) + '\n' +
        '{partial\n',
    );

    const all = await receipts.list();
    expect(all).toHaveLength(1);
    expect(all[0].amount_atomic).toBe('1000');
  });
});
