/**
 * Confirm policy — asks the human to approve a payment via MCP elicitation
 * before the gateway signs it.
 *
 * Three modes via `X402_REQUIRE_CONFIRM`:
 *   - `always` (default): every payment, regardless of size
 *   - `never`: skip elicitation entirely; caps are the only gate
 *   - a USDC amount (e.g. `0.01`): confirm only at or above that amount
 *
 * Fallback when the client doesn't declare elicitation capability:
 *   - default: log a one-time warning and proceed (caps still apply)
 *   - `X402_CONFIRM_STRICT=1`: refuse the payment instead
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../log.js';
import { formatUsdcAtomic, parseUsdcLimit } from './format.js';

export type ConfirmMode =
  | { type: 'always' }
  | { type: 'never' }
  | { type: 'threshold'; minAtomic: bigint };

export type ConfirmConfig = {
  mode: ConfirmMode;
  strict: boolean;
};

export const DEFAULT_CONFIRM_MODE: ConfirmMode = { type: 'always' };

export type ConfirmDecision = { ok: true } | { ok: false; reason: string };

export type ConfirmAskArgs = {
  amountAtomic: bigint;
  host: string;
  method: string;
  url: string;
  todaySpentAtomic: bigint;
  dailyCapAtomic: bigint;
};

export class ConfirmPolicy {
  private warnedNoElicitation = false;

  constructor(public readonly config: ConfirmConfig) {}

  static fromEnv(): ConfirmPolicy {
    const raw = process.env.X402_REQUIRE_CONFIRM?.trim().toLowerCase();
    let mode: ConfirmMode;
    if (raw === undefined || raw === '' || raw === 'always') {
      mode = { type: 'always' };
    } else if (raw === 'never' || raw === 'off') {
      mode = { type: 'never' };
    } else {
      try {
        const minAtomic = parseUsdcLimit(raw);
        mode = { type: 'threshold', minAtomic };
      } catch {
        throw new Error(
          `X402_REQUIRE_CONFIRM must be 'always', 'never', or a USDC amount; got "${raw}"`,
        );
      }
    }
    const strict = process.env.X402_CONFIRM_STRICT === '1';
    return new ConfirmPolicy({ mode, strict });
  }

  /** Pure decision: would a payment of this amount need a prompt? */
  shouldConfirm(amountAtomic: bigint): boolean {
    switch (this.config.mode.type) {
      case 'never':
        return false;
      case 'always':
        return true;
      case 'threshold':
        return amountAtomic >= this.config.mode.minAtomic;
    }
  }

  /**
   * Send an elicitation if needed. Returns `{ ok: true }` to proceed,
   * `{ ok: false, reason }` to abort. Safe to call regardless of mode —
   * if `shouldConfirm` is false, returns ok immediately without touching
   * the server.
   */
  async ask(server: McpServer, args: ConfirmAskArgs): Promise<ConfirmDecision> {
    if (!this.shouldConfirm(args.amountAtomic)) return { ok: true };

    const caps = server.server.getClientCapabilities();
    const elicitationSupported = caps?.elicitation !== undefined;

    if (!elicitationSupported) {
      if (this.config.strict) {
        return {
          ok: false,
          reason:
            "client doesn't support MCP elicitation but X402_CONFIRM_STRICT=1 is set",
        };
      }
      if (!this.warnedNoElicitation) {
        logger.warn(
          'client does not support MCP elicitation; payments will proceed without per-call confirmation (caps still enforced)',
        );
        this.warnedNoElicitation = true;
      }
      return { ok: true };
    }

    let result;
    try {
      result = await server.server.elicitInput({
        message: formatPrompt(args),
        requestedSchema: {
          type: 'object',
          properties: {
            approve: {
              type: 'boolean',
              title: 'Approve',
              description: `Approve $${formatUsdcAtomic(args.amountAtomic)} USDC payment to ${args.host}?`,
            },
          },
          required: ['approve'],
        },
        task: { ttl: 30_000 },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('elicitation request failed', { err: msg });
      return { ok: false, reason: `confirmation failed: ${msg}` };
    }

    if (result.action === 'cancel') {
      return { ok: false, reason: 'payment cancelled by user' };
    }
    if (result.action === 'decline') {
      return { ok: false, reason: 'payment declined by user' };
    }
    if (result.content?.approve !== true) {
      return { ok: false, reason: 'payment declined by user' };
    }
    return { ok: true };
  }
}

function formatPrompt(args: ConfirmAskArgs): string {
  const path = (() => {
    try {
      const u = new URL(args.url);
      return u.pathname + u.search;
    } catch {
      return args.url;
    }
  })();
  return [
    `Confirm payment to ${args.host}`,
    `  Amount:   $${formatUsdcAtomic(args.amountAtomic)} USDC (Base mainnet)`,
    `  Resource: ${args.method} ${path}`,
    `  Today:    $${formatUsdcAtomic(args.todaySpentAtomic)} of $${formatUsdcAtomic(args.dailyCapAtomic)} daily cap`,
  ].join('\n');
}
