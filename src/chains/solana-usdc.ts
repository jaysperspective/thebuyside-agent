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
import type { ChargeRequest } from '../mpp/types.js';
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

    // x402 SVM scheme: feePayer MUST NOT appear in any instruction's accounts.
    // MPP relaxes this rule — see `buildPaymentMpp` below.
    if (feePayer.equals(sourceAta) || feePayer.equals(destAta) || feePayer.equals(seller) || feePayer.equals(mint)) {
      throw new Error(
        'feePayer collides with an instruction account (source ATA, dest ATA, ' +
          'seller, or mint) — refusing to build tx. This violates the SVM scheme ' +
          'safety rule.',
      );
    }

    const memoText = readMemo(reqs.extra) ?? randomHexNonce(16);
    const recentBlockhash = await this.fetchBlockhash();
    return {
      tx: buildTransferTx({
        payer,
        seller,
        feePayer,
        mint,
        amount: BigInt(reqs.maxAmountRequired),
        memo: memoText,
        recentBlockhash,
      }),
    };
  }

  /**
   * MPP-flavored payment build. Mirrors `buildPayment` but reads the inputs
   * from an MPP `ChargeRequest` (paymentauth.org/draft-solana-charge-00) and
   * uses the seller-supplied `recentBlockhash` instead of fetching one.
   *
   * Scope: USDC mainnet, pull mode (server is feePayer), standard SPL Token
   * program. Push mode (`feePayer: false`) is not supported here — the buyer
   * would need its own SOL balance and gas-pricing logic.
   */
  async buildPaymentMpp(
    charge: ChargeRequest,
    payerPubkey: string,
  ): Promise<{ tx: VersionedTransaction }> {
    if (charge.currency !== USDC_MAINNET_MINT) {
      throw new Error(
        `solana-usdc adapter only handles the USDC mint (${USDC_MAINNET_MINT}); ` +
          `MPP challenge asked for currency=${charge.currency}.`,
      );
    }
    if (charge.methodDetails.tokenProgram !== TOKEN_PROGRAM_ID.toBase58()) {
      throw new Error(
        `MPP challenge requires non-standard token program ${charge.methodDetails.tokenProgram}; ` +
          `only the standard SPL Token program is supported in v0.5.0.`,
      );
    }
    if (charge.methodDetails.decimals !== USDC_DECIMALS) {
      throw new Error(
        `MPP challenge declares decimals=${charge.methodDetails.decimals}; ` +
          `USDC requires decimals=${USDC_DECIMALS}.`,
      );
    }
    if (!charge.methodDetails.feePayer) {
      throw new Error(
        'MPP push mode (`methodDetails.feePayer: false`) is not supported in ' +
          'v0.5.0 — the buyer cannot be the fee payer in this gateway.',
      );
    }
    if (!charge.methodDetails.feePayerKey) {
      throw new Error(
        'MPP pull-mode challenge missing `methodDetails.feePayerKey` — required ' +
          'when `feePayer: true` so the buyer knows whose pubkey to record as ' +
          'the transaction fee payer.',
      );
    }

    const payer = new PublicKey(payerPubkey);
    const seller = new PublicKey(charge.recipient);
    const feePayer = new PublicKey(charge.methodDetails.feePayerKey);
    const mint = new PublicKey(charge.currency);

    if (feePayer.equals(payer)) {
      throw new Error(
        'seller-declared feePayer equals the buyer pubkey — refusing to sign. ' +
          'Buyer must not appear as feePayer in pull mode.',
      );
    }

    return {
      tx: buildTransferTx({
        payer,
        seller,
        feePayer,
        mint,
        amount: BigInt(charge.amount),
        memo: null,
        recentBlockhash: charge.methodDetails.recentBlockhash,
      }),
    };
  }

  private async fetchBlockhash(): Promise<string> {
    if (this.blockhashFetcher) return this.blockhashFetcher();
    const conn = new Connection(this.rpcUrl, 'confirmed');
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    return blockhash;
  }
}

/** Build the 4-instruction USDC transferChecked tx shared by x402 and MPP. */
function buildTransferTx(args: {
  payer: PublicKey;
  seller: PublicKey;
  feePayer: PublicKey;
  mint: PublicKey;
  amount: bigint;
  /** Memo instruction text. `null` skips the memo (required for MPP — its verify rejects extra programs). */
  memo: string | null;
  recentBlockhash: string;
}): VersionedTransaction {
  const sourceAta = getAssociatedTokenAddressSync(args.mint, args.payer);
  const destAta = getAssociatedTokenAddressSync(args.mint, args.seller);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
    createTransferCheckedInstruction(
      sourceAta,
      args.mint,
      destAta,
      args.payer,
      args.amount,
      USDC_DECIMALS,
      [],
      TOKEN_PROGRAM_ID,
    ),
  ];
  if (args.memo !== null) {
    instructions.push(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(args.memo, 'utf8'),
      }),
    );
  }

  const messageV0 = new TransactionMessage({
    payerKey: args.feePayer,
    recentBlockhash: args.recentBlockhash,
    instructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
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
