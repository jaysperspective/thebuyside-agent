/**
 * SolanaUsdcAdapter — Solana mainnet, USDC SPL transfer, x402 v2 `exact` SVM.
 *
 * Builds the partially-signed transaction that the buyer signs and the
 * facilitator (the seller's `extra.feePayer`) co-signs and broadcasts.
 *
 * Required instruction order per spec (scheme_exact_svm.md):
 *   1. ComputeBudget: SetComputeUnitLimit
 *   2. ComputeBudget: SetComputeUnitPrice
 *   3. SPL Token TransferChecked (source ATA → seller ATA)
 *   4. Memo — value from `extra.memo` if present, else a random 16-byte
 *      hex nonce
 *
 * The buyer is NOT the feePayer — the seller's facilitator covers SOL gas.
 * Critical safety rule (also enforced explicitly below): the feePayer
 * pubkey MUST NOT appear in any instruction's accounts list, otherwise
 * the buyer would be implicitly signing as the feePayer.
 *
 * Asset scope: this adapter only handles the USDC mint on Solana mainnet.
 * Other SPL tokens or the Token-2022 program would need a sibling
 * adapter — the wire-level scheme is the same but decimals and program
 * ID differ.
 *
 * Blockhash: a versioned tx requires a recent blockhash. We fetch one
 * from a public Solana RPC at build time. Configurable via
 * X402_SOLANA_RPC; default is api.mainnet-beta.solana.com. Cached for
 * a short window since Solana blockhashes are valid for ~60 seconds
 * and an x402 round trip typically fits well inside that.
 */

import { randomBytes } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { PaymentRequirements } from '../x402/types.js';
import type { SolanaChainAdapter } from './adapter.js';

const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Compute budget — generous enough for transferChecked + memo + a touch of slack. */
const COMPUTE_UNIT_LIMIT = 60_000;
/** Micro-lamports per CU. 1000 = ~0.0006 SOL on a 60k CU tx; adequate priority. */
const COMPUTE_UNIT_PRICE = 1_000;

export type SolanaUsdcAdapterOptions = {
  /** Override the Solana RPC URL. Defaults to mainnet-beta. */
  rpcUrl?: string;
  /** Test seam — fetch a blockhash without a real RPC. */
  blockhashFetcher?: () => Promise<string>;
};

export class SolanaUsdcAdapter implements SolanaChainAdapter {
  readonly id = 'solana';
  readonly kind = 'svm' as const;
  private readonly rpcUrl: string;
  private readonly blockhashFetcher?: () => Promise<string>;

  constructor(opts: SolanaUsdcAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? process.env.X402_SOLANA_RPC ?? DEFAULT_RPC_URL;
    this.blockhashFetcher = opts.blockhashFetcher;
  }

  matches(network: string): boolean {
    return (
      network === 'solana' ||
      network === `solana:${SOLANA_MAINNET_GENESIS}`
    );
  }

  async buildPayment(
    reqs: PaymentRequirements,
    payerPubkey: string,
  ): Promise<{ tx: VersionedTransaction }> {
    if ((reqs.asset as string) !== USDC_MAINNET_MINT) {
      throw new Error(
        `solana-usdc adapter only handles the USDC mint (${USDC_MAINNET_MINT}); ` +
          `seller asked for asset=${reqs.asset}. Different SPL token or Token-2022 ` +
          `would need a sibling adapter.`,
      );
    }

    const feePayerStr = readFeePayer(reqs.extra);
    if (!feePayerStr) {
      throw new Error(
        'solana 402 challenge missing required `extra.feePayer` — the seller ' +
          'must declare a facilitator pubkey to cover SOL gas. The x402 SVM ' +
          'spec does not allow the buyer to be the fee payer.',
      );
    }

    const payer = new PublicKey(payerPubkey);
    const seller = new PublicKey(reqs.payTo);
    const feePayer = new PublicKey(feePayerStr);
    const mint = new PublicKey(reqs.asset);

    if (feePayer.equals(payer)) {
      throw new Error(
        'seller-declared feePayer equals the buyer pubkey — refusing to sign. ' +
          'Per scheme_exact_svm.md the buyer must not appear as feePayer.',
      );
    }

    const sourceAta = getAssociatedTokenAddressSync(mint, payer);
    const destAta = getAssociatedTokenAddressSync(mint, seller);

    // Spec: feePayer MUST NOT appear in any instruction's accounts.
    if (feePayer.equals(sourceAta) || feePayer.equals(destAta) || feePayer.equals(seller) || feePayer.equals(mint)) {
      throw new Error(
        'feePayer collides with an instruction account (source ATA, dest ATA, ' +
          'seller, or mint) — refusing to build tx. This violates the SVM scheme ' +
          'safety rule.',
      );
    }

    const memoText = readMemo(reqs.extra) ?? randomHexNonce(16);
    const amount = BigInt(reqs.maxAmountRequired);

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destAta,
        payer,
        amount,
        USDC_DECIMALS,
        [],
        TOKEN_PROGRAM_ID,
      ),
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(memoText, 'utf8'),
      }),
    ];

    const recentBlockhash = await this.fetchBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    return { tx };
  }

  private async fetchBlockhash(): Promise<string> {
    if (this.blockhashFetcher) return this.blockhashFetcher();
    const conn = new Connection(this.rpcUrl, 'confirmed');
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    return blockhash;
  }
}

function readFeePayer(extra: unknown): string | null {
  if (extra && typeof extra === 'object' && 'feePayer' in extra) {
    const f = (extra as Record<string, unknown>).feePayer;
    if (typeof f === 'string' && f.length > 0) return f;
  }
  return null;
}

function readMemo(extra: unknown): string | null {
  if (extra && typeof extra === 'object' && 'memo' in extra) {
    const m = (extra as Record<string, unknown>).memo;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return null;
}

function randomHexNonce(byteLen: number): string {
  return randomBytes(byteLen).toString('hex');
}
