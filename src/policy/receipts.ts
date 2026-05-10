/**
 * Receipts log — append-only JSON-lines record of every settled payment.
 *
 * One receipt per line keeps the file trivially inspectable and recoverable.
 * No locking is needed because the gateway is a single-process MCP server.
 *
 * Default location: `<project>/.local/receipts.jsonl` (gitignored).
 * Override with `X402_RECEIPTS_PATH` in the env.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

export const DEFAULT_RECEIPTS_PATH = resolve(projectRoot, '.local', 'receipts.jsonl');

export type Receipt = {
  id: string;
  ts: string; // ISO 8601
  host: string;
  url: string;
  method: string;
  /** Atomic units of the asset, as a decimal string (e.g. "5000" = $0.005 USDC). */
  amount_atomic: string;
  asset: string; // "USDC"
  chain: string; // "base"
  tx_hash: string | null;
};

export type ReceiptInput = Omit<Receipt, 'id' | 'ts'>;

export class Receipts {
  constructor(public readonly filepath: string = DEFAULT_RECEIPTS_PATH) {}

  static fromEnv(): Receipts {
    const path = process.env.X402_RECEIPTS_PATH;
    return new Receipts(path && path.trim().length > 0 ? path : DEFAULT_RECEIPTS_PATH);
  }

  async record(input: ReceiptInput): Promise<Receipt> {
    const receipt: Receipt = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...input,
    };
    await mkdir(dirname(this.filepath), { recursive: true });
    await appendFile(this.filepath, JSON.stringify(receipt) + '\n', 'utf8');
    logger.info('receipt recorded', {
      id: receipt.id,
      host: receipt.host,
      amount: receipt.amount_atomic,
    });
    return receipt;
  }

  async list(): Promise<Receipt[]> {
    let text: string;
    try {
      text = await readFile(this.filepath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Receipt[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as Receipt);
      } catch {
        logger.warn('receipts: skipping malformed line', { line: line.slice(0, 80) });
      }
    }
    return out;
  }

  /** Sum of `amount_atomic` for receipts in the last `hours` window. */
  async spentSinceHours(hours: number): Promise<bigint> {
    const cutoffMs = Date.now() - hours * 3600_000;
    const all = await this.list();
    let sum = 0n;
    for (const r of all) {
      if (Date.parse(r.ts) >= cutoffMs) {
        sum += BigInt(r.amount_atomic);
      }
    }
    return sum;
  }
}
