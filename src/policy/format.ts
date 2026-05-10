/**
 * Format helpers for atomic USDC amounts.
 *
 * USDC has 6 decimals: 1 USDC = 1,000,000 atomic units. We hold amounts as
 * `bigint` of atomic units everywhere, and only format to dollars-and-cents
 * strings at the I/O boundary (logs, error messages, MCP tool responses).
 */

/** Format an atomic USDC value (6 decimals) as `D.dddddd`. */
export function formatUsdcAtomic(atomic: bigint): string {
  if (atomic < 0n) return '-' + formatUsdcAtomic(-atomic);
  const whole = atomic / 1_000_000n;
  const frac = atomic % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, '0')}`;
}

/**
 * Parse a USDC limit string. Accepts either `0.05` (decimal USDC) or
 * `50000` (atomic units). Returns `bigint` atomic units.
 */
export function parseUsdcLimit(raw: string): bigint {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('parseUsdcLimit: empty input');
  if (trimmed.includes('.')) {
    const [whole, frac = ''] = trimmed.split('.');
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) {
      throw new Error(`parseUsdcLimit: invalid decimal "${raw}"`);
    }
    if (frac.length > 6) {
      throw new Error(`parseUsdcLimit: USDC has 6 decimals, "${raw}" has more`);
    }
    const padded = (frac + '000000').slice(0, 6);
    return BigInt(whole) * 1_000_000n + BigInt(padded);
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`parseUsdcLimit: invalid integer "${raw}"`);
  }
  return BigInt(trimmed);
}
