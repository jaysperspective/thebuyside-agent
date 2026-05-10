# Install in Claude Desktop

For Claude Code (CLI) install, see the [README quickstart](../README.md#quickstart).

## 1. Find the config file

macOS:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Windows:

```
%APPDATA%\Claude\claude_desktop_config.json
```

Linux:

```
~/.config/Claude/claude_desktop_config.json
```

If the file doesn't exist, create it.

## 2. Add the gateway

Open the file and add (or merge into the existing `mcpServers` block). You can configure either Base (EVM), Solana (SVM), or both — sellers offering multiple chains are routed by accept order, typically EVM first.

```json
{
  "mcpServers": {
    "x402-pay": {
      "command": "npx",
      "args": ["-y", "thebuyside-x402-agent"],
      "env": {
        "X402_PAYER_PRIVATE_KEY": "0x...",
        "X402_PAYER_SOLANA_KEY": "<base58 secret>"
      }
    }
  }
}
```

- **`X402_PAYER_PRIVATE_KEY`** — Base-mainnet EVM private key (0x-prefixed, 64 hex chars). Fund with `$0.01 USDC` on Base.
- **`X402_PAYER_SOLANA_KEY`** — Solana secret key. Accepts the base58 string Phantom exports under "Show Private Key", or the JSON-array format `solana-keygen new` writes. Fund with `$0.01 USDC` (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) on Solana mainnet. The buyer wallet does NOT need any SOL — the seller's facilitator covers network fees.

Configure only the chains you intend to use. With neither key, the gateway boots and lists tools but can't pay anything. Use a fresh wallet for each, not your main one.

> **Why the `env` block?** Claude Desktop spawns the MCP server as a subprocess and doesn't pass through your shell's environment. Setting keys in the config is the most reliable path.

## 3. Override spend caps (optional)

The same `env` block accepts any of the configuration variables — see the [README config table](../README.md#configuration). Common overrides:

```json
{
  "mcpServers": {
    "x402-pay": {
      "command": "npx",
      "args": ["-y", "thebuyside-x402-agent"],
      "env": {
        "X402_PAYER_PRIVATE_KEY": "0x...",
        "X402_PAYER_SOLANA_KEY": "<base58 secret>",
        "X402_DAILY_LIMIT": "0.50",
        "X402_PER_CALL_LIMIT": "0.02"
      }
    }
  }
}
```

## 4. Restart Claude Desktop

Fully quit (cmd+Q on macOS) and relaunch. The three tools — `x402.discover`, `x402.fetch`, `x402.wallet_status` — should appear in the tool picker.

## 5. Verify

Ask Claude:

> *"Use the x402.wallet_status tool."*

You should get JSON back with your wallet address and spend info. If you get an error like "tool not found," check the Claude Desktop MCP logs panel (in the developer menu) for startup errors from `thebuyside-x402-agent`.

## Troubleshooting

**Server fails to start:**
- Confirm Node 20+ is on PATH: `node --version`. Claude Desktop uses your login shell's PATH, so if `npx` isn't found, the issue is usually Node not being installed system-wide.
- Try the bare command in a terminal: `npx -y thebuyside-x402-agent` should boot the server (it'll wait for stdin — that's expected). Ctrl-C to exit.

**Tools appear but `x402.fetch` returns "no wallet configured":**
- Neither `X402_PAYER_PRIVATE_KEY` nor `X402_PAYER_SOLANA_KEY` is set. Add at least one to the `env` block as shown above, then restart Claude Desktop.

**`x402.fetch` returns "no chain adapter + matching signer for any of the offered networks":**
- The seller's 402 challenge only advertised chains for which you don't have a signer configured. For example, a Solana-only seller when you only configured `X402_PAYER_PRIVATE_KEY`. Either add the corresponding key to your `env` block, or pick a different seller from `x402.discover` — the `source` field on each result hints at which chains it likely supports (`cdp-bazaar` and `x402watch` index both chains; results may be Solana-only).

**Tools work but every call returns "host ... is not in the allowlist":**
- The host you're trying to fetch isn't in the bundled registry. Either submit a PR to add it (see [adding-an-api.md](adding-an-api.md)) or set `X402_ALLOWLIST=that-host.com` in the `env` block.
