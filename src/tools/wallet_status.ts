/**
 * x402.wallet_status — return wallet address, today's spend, and configured limits.
 *
 * Reads spent-today from the receipts log; reads limits and allowlist from the
 * gateway's configured policy modules.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Gateway } from '../gateway.js';
import { logger } from '../log.js';
import { formatUsdcAtomic } from '../policy/format.js';

export function registerWalletStatus(server: McpServer, gateway: Gateway): void {
  server.registerTool(
    'x402.wallet_status',
    {
      title: 'Wallet status',
      description:
        "Return the gateway wallet address, today's spend total in USDC, and " +
        'the configured per-call and per-day spend limits. Use this to surface ' +
        'payment context to the user.',
      inputSchema: {},
    },
    async () => {
      logger.info('wallet_status called');

      const spentTodayAtomic = await gateway.caps.spentTodayAtomic();
      const dailyAtomic = gateway.caps.config.dailyLimitAtomic;
      const remainingAtomic = dailyAtomic - spentTodayAtomic;

      const evmAddr = gateway.signers.evm?.address ?? null;
      const svmAddr = gateway.signers.svm?.publicKey ?? null;
      const status = {
        // Backward-compat: pre-M8 callers expect a string `address`. If only
        // one chain is configured, that's the address. If both are configured,
        // we expose `address` for EVM (the original chain) and `solana_address`
        // separately. If neither is configured, the message stays the same.
        address:
          evmAddr ??
          svmAddr ??
          '(no wallet — set X402_PAYER_PRIVATE_KEY and/or X402_PAYER_SOLANA_KEY)',
        evm_address: evmAddr,
        solana_address: svmAddr,
        chains: gateway.chains.map((c) => c.id),
        chains_with_signer: [
          ...(evmAddr ? ['evm'] : []),
          ...(svmAddr ? ['svm'] : []),
        ],
        currency: 'USDC',
        spent_today_usdc: formatUsdcAtomic(spentTodayAtomic),
        daily_limit_usdc: formatUsdcAtomic(dailyAtomic),
        remaining_usdc: formatUsdcAtomic(remainingAtomic > 0n ? remainingAtomic : 0n),
        per_call_limit_usdc: formatUsdcAtomic(gateway.caps.config.perCallLimitAtomic),
        allowlist: gateway.allowlist.allowedHosts,
        allowlist_unrestricted: gateway.allowlist.isUnrestricted,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      };
    },
  );
}
