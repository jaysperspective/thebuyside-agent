/**
 * Unit tests for SolanaUsdcAdapter — instruction structure, ATA derivation,
 * memo handling, feePayer safety guards, and asset/network gating.
 *
 * Tests inject a stub blockhashFetcher to avoid real RPC calls.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
} from '@solana/web3.js';
import {
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { SolanaUsdcAdapter } from '../src/chains/solana-usdc.js';
import type { PaymentRequirements } from '../src/x402/types.js';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

const BUYER = Keypair.fromSeed(Buffer.alloc(32, 1));
const SELLER = Keypair.fromSeed(Buffer.alloc(32, 2));
const FEE_PAYER = Keypair.fromSeed(Buffer.alloc(32, 3));

const STUB_BLOCKHASH = bs58.encode(Buffer.alloc(32, 9));

function makeAdapter(): SolanaUsdcAdapter {
  return new SolanaUsdcAdapter({
    blockhashFetcher: async () => STUB_BLOCKHASH,
  });
}

function makeReqs(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: SOLANA_MAINNET,
    maxAmountRequired: '5000',
    resource: 'https://example.test/api',
    payTo: SELLER.publicKey.toBase58() as unknown as PaymentRequirements['payTo'],
    maxTimeoutSeconds: 60,
    asset: USDC_MINT as unknown as PaymentRequirements['asset'],
    extra: { feePayer: FEE_PAYER.publicKey.toBase58() },
    ...overrides,
  };
}

describe('SolanaUsdcAdapter.matches', () => {
  const a = makeAdapter();

  it('matches the short form `solana`', () => {
    expect(a.matches('solana')).toBe(true);
  });

  it('matches the CAIP-2 mainnet identifier', () => {
    expect(a.matches(SOLANA_MAINNET)).toBe(true);
  });

  it('does not match Base or any EVM network', () => {
    expect(a.matches('base')).toBe(false);
    expect(a.matches('eip155:8453')).toBe(false);
  });

  it('does not match a Solana devnet/testnet identifier', () => {
    expect(a.matches('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(false);
  });
});

describe('SolanaUsdcAdapter.buildPayment — happy path', () => {
  it('builds a versioned tx with exactly the required 4 instructions in order', async () => {
    const a = makeAdapter();
    const { tx } = await a.buildPayment(makeReqs(), BUYER.publicKey.toBase58());

    const decompiled = TransactionMessage.decompile(tx.message);
    expect(decompiled.instructions).toHaveLength(4);
    expect(decompiled.instructions[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(decompiled.instructions[1].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(decompiled.instructions[2].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(decompiled.instructions[3].programId.equals(MEMO_PROGRAM_ID)).toBe(true);
  });

  it('sets feePayer to the seller-declared pubkey (not the buyer)', async () => {
    const a = makeAdapter();
    const { tx } = await a.buildPayment(makeReqs(), BUYER.publicKey.toBase58());
    const decompiled = TransactionMessage.decompile(tx.message);
    expect(decompiled.payerKey.equals(FEE_PAYER.publicKey)).toBe(true);
    expect(decompiled.payerKey.equals(BUYER.publicKey)).toBe(false);
  });

  it('TransferChecked uses derived ATAs (PDA) for source and destination', async () => {
    const a = makeAdapter();
    const { tx } = await a.buildPayment(makeReqs(), BUYER.publicKey.toBase58());
    const decompiled = TransactionMessage.decompile(tx.message);

    const expectedSource = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      BUYER.publicKey,
    );
    const expectedDest = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      SELLER.publicKey,
    );

    const decoded = decodeTransferCheckedInstruction(decompiled.instructions[2]);
    expect(decoded.keys.source.pubkey.equals(expectedSource)).toBe(true);
    expect(decoded.keys.destination.pubkey.equals(expectedDest)).toBe(true);
    expect(decoded.keys.mint.pubkey.toBase58()).toBe(USDC_MINT);
    expect(decoded.keys.owner.pubkey.equals(BUYER.publicKey)).toBe(true);
  });

  it('TransferChecked carries the requested amount and 6 decimals', async () => {
    const a = makeAdapter();
    const { tx } = await a.buildPayment(
      makeReqs({ maxAmountRequired: '12345' }),
      BUYER.publicKey.toBase58(),
    );
    const decompiled = TransactionMessage.decompile(tx.message);
    const decoded = decodeTransferCheckedInstruction(decompiled.instructions[2]);
    expect(decoded.data.amount).toBe(12345n);
    expect(decoded.data.decimals).toBe(6);
  });

  it('uses extra.memo verbatim when present', async () => {
    const a = makeAdapter();
    const memo = 'pi_3abc123def456';
    const { tx } = await a.buildPayment(
      makeReqs({ extra: { feePayer: FEE_PAYER.publicKey.toBase58(), memo } }),
      BUYER.publicKey.toBase58(),
    );
    const decompiled = TransactionMessage.decompile(tx.message);
    const memoIx = decompiled.instructions[3];
    expect(Buffer.from(memoIx.data).toString('utf8')).toBe(memo);
  });

  it('falls back to a 16-byte hex nonce when extra.memo is absent', async () => {
    const a = makeAdapter();
    const { tx } = await a.buildPayment(makeReqs(), BUYER.publicKey.toBase58());
    const decompiled = TransactionMessage.decompile(tx.message);
    const memoIx = decompiled.instructions[3];
    const memoText = Buffer.from(memoIx.data).toString('utf8');
    // 16 bytes hex-encoded = 32 chars
    expect(memoText).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('SolanaUsdcAdapter.buildPayment — guards', () => {
  it('rejects a non-USDC asset', async () => {
    const a = makeAdapter();
    await expect(
      a.buildPayment(
        makeReqs({
          asset: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' as unknown as PaymentRequirements['asset'],
        }),
        BUYER.publicKey.toBase58(),
      ),
    ).rejects.toThrow(/only handles the USDC mint/);
  });

  it('rejects a challenge missing extra.feePayer', async () => {
    const a = makeAdapter();
    await expect(
      a.buildPayment(makeReqs({ extra: {} }), BUYER.publicKey.toBase58()),
    ).rejects.toThrow(/missing required `extra\.feePayer`/);
  });

  it('rejects when the seller-declared feePayer equals the buyer pubkey', async () => {
    const a = makeAdapter();
    await expect(
      a.buildPayment(
        makeReqs({ extra: { feePayer: BUYER.publicKey.toBase58() } }),
        BUYER.publicKey.toBase58(),
      ),
    ).rejects.toThrow(/feePayer equals the buyer pubkey/);
  });

  it('rejects when feePayer collides with the seller pubkey', async () => {
    const a = makeAdapter();
    await expect(
      a.buildPayment(
        makeReqs({ extra: { feePayer: SELLER.publicKey.toBase58() } }),
        BUYER.publicKey.toBase58(),
      ),
    ).rejects.toThrow(/collides with an instruction account/);
  });
});
