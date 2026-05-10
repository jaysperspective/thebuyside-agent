# thebuyside-agent

The MCP gateway that lets any AI agent discover and pay x402-priced APIs — without the user wiring payments themselves.

`thebuyside-agent` is the canonical buyer-side reference implementation for [x402](https://x402.org), the HTTP 402 payment standard stewarded by the Linux Foundation. Drop it into Claude Code, Claude Desktop, Cursor, or any MCP client, and your agent gains three tools:

- **`x402.discover`** — search a curated registry of x402-priced APIs
- **`x402.fetch`** — call one (the gateway pays the 402 challenge automatically)
- **`x402.wallet_status`** — show the gateway's wallet, today's spend, and caps

The agent never sees the 402, never sees a wallet, never holds a private key.

## Status

**v0 shipped 2026-05-10.** First end-to-end paid call from Claude Code:

> `$0.005 USDC` settled on Base mainnet — tx [`0xd0917b35d8b778cf8d0249cc1b107a48ff7125b9fcaf7b4b257d823f73cc6aac`](https://basescan.org/tx/0xd0917b35d8b778cf8d0249cc1b107a48ff7125b9fcaf7b4b257d823f73cc6aac)

- 65 unit tests + MCP smoke test, all green
- x402 v1 + v2 dual wire support (handles both transports)
- Spend caps, host allowlist, receipts log, self-transfer guard, confirm-before-pay (MCP elicitation)
- Apache 2.0, DCO not CLA

## Quickstart

Two steps. You need Node 20+ and a Base-mainnet wallet funded with at least `$0.01 USDC`.

### 1. Set the wallet key in your environment

```bash
export X402_PAYER_PRIVATE_KEY=0x...
```

Use a fresh wallet, not your main one. (You can also pass this via your MCP client's `env` block — see below.)

### 2. Register the gateway with your MCP client

**Claude Code (CLI):**

```bash
claude mcp add x402-pay -- npx -y thebuyside-agent
```

Open a session, type `/mcp` to verify, then ask: *"Use x402.wallet_status to show my wallet."*

**Claude Desktop:**

See [docs/install-claude-desktop.md](docs/install-claude-desktop.md).

> Local stdio MCP servers can only be reached by **local** MCP clients (Claude Code CLI, Claude Desktop). The claude.ai web app's "Code" mode runs in Anthropic's cloud and can't reach a server on your laptop.

## Try it

Once connected, ask the model:

> *"Use x402.discover to find APIs about news."*

> *"Use x402.fetch to get https://news-ep.com/api/v1/stories?market=houston&limit=5"*

The first returns the registry. The second pays `$0.005 USDC` and returns Houston news.

After a successful call, ask `x402.wallet_status` and you'll see today's spend reflected.

## Configuration

Spend controls have safe defaults. Override via env if needed.

| Var | Default | What it does |
| --- | --- | --- |
| `X402_PAYER_PRIVATE_KEY` | *(required for payment)* | Base-mainnet wallet key (0x-prefixed) |
| `X402_DAILY_LIMIT` | `1.00` | Max USDC spent per rolling 24h window |
| `X402_PER_CALL_LIMIT` | `0.05` | Max USDC per single call |
| `X402_ALLOWLIST` | hosts in `seed.json` | Comma-separated extra allowed hostnames |
| `X402_ALLOW_UNVERIFIED` | *(off)* | `1` allows any host — dev only |
| `X402_REQUIRE_CONFIRM` | `always` | `always`, `never`, or a USDC threshold (e.g. `0.01`). Asks the user to approve via MCP elicitation before signing |
| `X402_CONFIRM_STRICT` | *(off)* | `1` refuses payment when the client doesn't support elicitation (default: log a warning and proceed) |
| `X402_RECEIPTS_PATH` | `.local/receipts.jsonl` | Where the receipts log is written |
| `X402_TEST_URL` | news-ep stories | Override target for `pnpm pay-newsep` |

Limit values accept either decimal USDC (`0.05`) or atomic units (`50000`). See [docs/configuring-spend-limits.md](docs/configuring-spend-limits.md) for the full guide.

## How it works

```
   Claude Code / Claude Desktop / Cursor
                  │
                  │  MCP over stdio
                  │
            ┌─────▼─────┐
            │  Gateway  │   ← src/server.ts (this repo)
            └─────┬─────┘
                  │
                  │  HTTPS GET → 402 challenge → EIP-3009 sign
                  │             → retry with PAYMENT-SIGNATURE
                  │             → 200 + body
                  │
            ┌─────▼──────┐         ┌──────────────────┐
            │ x402 server│ ──────→ │ CDP facilitator  │ ─→ Base USDC settle
            │ (e.g.      │         │ (verify + submit │
            │  news-ep)  │ ←────── │  tx)             │
            └────────────┘         └──────────────────┘
```

The gateway holds the wallet, drives the 402 → sign → 200 loop, enforces spend caps, writes a receipts log. The agent stays at the MCP layer and never deals with payment plumbing.

## Run from source

For contributors and anyone who wants to hack on the gateway:

```bash
git clone https://github.com/jaysperspective/thebuyside-agent.git
cd thebuyside-agent
pnpm install
cp .env.example .env   # then paste your key into X402_PAYER_PRIVATE_KEY
```

Useful scripts:

- **`pnpm pay-newsep`** — standalone script that pays news-ep `$0.005` end-to-end without MCP. Useful for verifying your wallet + protocol setup.
- **`pnpm smoke`** — spawns the MCP server in a subprocess and round-trips a few tool calls. CI-safe; no real payments.
- **`pnpm verify-seed`** — hits each registry entry's example URL and asserts a valid 402 with the advertised price. Run nightly in CI.
- **`pnpm test`** — the full vitest unit-test suite.
- **`pnpm build`** — compiles to `dist/`. Used by `npm publish`.

To point your MCP client at the local source instead of the published npm package:

```bash
claude mcp add x402-pay -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/src/index.ts"
```

## Adding an API to the registry

The discover tool reads `src/registry/seed.json`. Adding a new x402-priced endpoint is a single PR — see [docs/adding-an-api.md](docs/adding-an-api.md). CI verifies the entry returns a clean 402 with your advertised price before merge.

## What this is *not*

- An agent framework. Bring your own.
- An LLM router. Bring your own.
- A marketplace. The registry is curated open-source data, not a vendor list.
- A custodial wallet service. Keys live in your `.env`. A managed-wallet (KMS) seam exists for a future hosted version, but the OSS gateway will always work BYO-key.

## Contributing

Apache 2.0. Sign your commits with DCO (`git commit -s`). No CLA. PRs welcome — small, focused, with tests.

## License

[Apache License 2.0](./LICENSE).
