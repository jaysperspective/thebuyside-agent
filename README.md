# thebuyside-agent

> MCP gateway for x402-priced APIs — buyer-side reference implementation.

## What this is

`thebuyside-agent` is the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) gateway that any MCP client — Claude Desktop, Cursor, IDE-based agents — can install to **discover and pay for x402-priced APIs** without the user wiring payments themselves.

It is intentionally narrow:

- **Gateway only.** No agent framework, no LLM router, no marketplace.
- **Base USDC at v0.** Solana / Pay.sh follow as a chain-adapter plug-in.
- **BYO wallet key.** The gateway reads a private key from a local `.env` file and signs payments with [viem](https://viem.sh/). A managed-wallet (KMS) path will land later for a hosted version.
- **Apache 2.0**, no CLA — just DCO sign-off on contributions.

The goal is to be the canonical reference implementation that closes the buyer-side gap in the x402 ecosystem.

## Status: 🚧 v0 in progress

| Milestone | What it proves | Status |
| --- | --- | --- |
| **M0** | Standalone script pays news-ep $0.005 USDC end-to-end. | ✅ |
| **M1** | MCP server with 3 stub tools shows up in Claude Desktop / Code. | ✅ |
| **M2** | M1 + M0 wired together. End-to-end paid call from Claude. | ⏳ |
| **M3** | Wallet status, seed list, install docs, CI verify. | ⏳ |

## Quickstart

### Prerequisites

- Node ≥20, pnpm ≥10
- (For M0 / M2 only) a Base-mainnet self-custody wallet with a few cents of USDC

### Install

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm smoke
```

After `cp .env.example .env`, edit `.env` and paste your wallet key into `X402_PAYER_PRIVATE_KEY` (optional at M1; required for M0/M2 live tests). `pnpm typecheck` runs the static check; `pnpm smoke` boots the MCP server, lists tools, and round-trips a call.

Expected smoke output:

```
[smoke] server returned 3 tools:
  - x402.discover  —  Discover x402-priced APIs
  - x402.fetch     —  Fetch an x402-priced URL (paying if required)
  - x402.wallet_status  —  Wallet status
[smoke] ✓ all 3 expected tools registered and reachable
```

## M0 — pay news-ep manually (standalone)

`scripts/pay-newsep.ts` drives the full x402 v1 loop end-to-end against [news-ep.com](https://news-ep.com): `GET` → `402` → EIP-3009 signed payment → `200`. No MCP. Settlement happens on Base mainnet via the Coinbase CDP facilitator.

```bash
pnpm pay-newsep
```

The settlement transaction will appear on [basescan.org](https://basescan.org) under the receiving wallet (`0xc8CaE186fb4f382D3DD9C82cbA976C255531540C`).

## M1 — install in an MCP client

The gateway speaks MCP over stdio. Register it with your client and the three tools — `x402.discover`, `x402.fetch`, `x402.wallet_status` — appear in the model's tool picker.

> At M1 the tools are stubs: `discover` returns a hardcoded list, `fetch` returns a canned response, `wallet_status` shows your real wallet address but zero spend. Real payments land in M2.

### Option A — Claude Code (CLI)

From the project directory, run this single line:

```bash
claude mcp add x402-pay -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/src/index.ts"
```

Then start a Claude Code session (`claude`), type `/mcp` to verify `x402-pay` shows as connected with 3 tools, and ask Claude to use the `x402.wallet_status` tool.

> **Note:** local stdio MCP servers like this one only work with **local** MCP clients (Claude Code CLI, Claude Desktop). They are *not* reachable from claude.ai's web "Code" mode, which runs in Anthropic's cloud and can only see hosted tools.

### Option B — Claude Desktop (`claude_desktop_config.json`)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add:

```json
{
  "mcpServers": {
    "x402-pay": {
      "command": "/ABSOLUTE/PATH/TO/thebuyside-agent/node_modules/.bin/tsx",
      "args": ["/ABSOLUTE/PATH/TO/thebuyside-agent/src/index.ts"]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/` with your actual path (run `pwd` in the project directory). Restart Claude Desktop. The three tools should appear in the tool picker.

### Verify

After registration, ask the model: *"Use x402.wallet_status to show my wallet."* You should get back the JSON with your wallet address (or a `(no wallet configured)` placeholder if you haven't set the private key yet).

## License

[Apache License 2.0](./LICENSE).
