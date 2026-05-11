# thebuyside-x402-agent

The MCP gateway that lets any AI agent discover and pay metered APIs on Base or Solana — without the user wiring payments themselves.

`thebuyside-x402-agent` is the canonical buyer-side reference implementation for two open agent-payment protocols:

- **[x402](https://x402.org)** — the HTTP 402 payment standard stewarded by the Linux Foundation. EVM (Base) and SVM (Solana) via the `exact` scheme.
- **MPP** — [Machine Payments Protocol](https://paymentauth.org/draft-solana-charge-00.html), the new RFC-7235-style protocol behind [pay.sh](https://pay.sh) (Solana Foundation × Google Cloud, launched May 2026). Solana mainnet USDC.

Drop it into Claude Code, Claude Desktop, Cursor, or any MCP client, and your agent gains three tools:

- **`pay.discover`** — search the curated registry plus three federated indexes (CDP Bazaar, agentic.market, x402watch) for paid APIs
- **`pay.fetch`** — call one (the gateway pays the 402 challenge automatically, on whichever chain you have a key for, speaking whichever protocol the seller uses)
- **`pay.wallet_status`** — show the gateway's wallet(s), today's spend, and caps

The agent never sees the 402, never sees a wallet, never holds a private key.

## Status

**v0.5.0 — first cross-implementation MPP-Solana settlement, 2026-05-11.** End-to-end live runs across all three supported protocol/chain combinations:

> Base mainnet · x402 v2 · `$0.005 USDC` · tx [`0xd0917b35…`](https://basescan.org/tx/0xd0917b35d8b778cf8d0249cc1b107a48ff7125b9fcaf7b4b257d823f73cc6aac)
>
> Solana mainnet · x402 v2 · `$0.005 USDC` · tx [`4DYWUMEx…`](https://solscan.io/tx/4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71)
>
> Solana mainnet · MPP `solana`/`charge` · `$0.001 USDC` · tx [`3UzJ7Uz…`](https://solscan.io/tx/3UzJ7UzhyLwAAFf5Jsnf5jcW9pXUV1BzDswnuxyvNvUgJXnorS5Moozb4fdnqCyy3fwPNLk5jYkqiX8USdpDLJmG)

That third settlement is, as far as we know, the first cross-implementation [Machine Payments Protocol](https://paymentauth.org/draft-solana-charge-00.html) round-trip on Solana — a JS buyer (this gateway, `@solana/web3.js`) paying a Python/FastAPI seller (news-ep.com, `solders`), with no shared code between sides. See [docs/mpp-implementer-notes.md](docs/mpp-implementer-notes.md) for the wire-format reference and the four pitfalls we hit during pair-test (RFC 7235 multi-challenge gating, strict tx instruction whitelist, `solders` v0-prefix byte gotcha, and middleware-onion ordering).

- 154 unit tests + MCP smoke test, all green
- **Dual-protocol**: speaks x402 v1 + v2 *and* MPP (`solana`/`charge` intent). `pay.fetch` peeks at the 402 and dispatches transparently — agents never know which protocol the seller uses.
- Multi-chain: configure either Base (EVM/EIP-3009) or Solana (SVM/SPL-TransferChecked) — or both. Sellers offering multiple chains are routed to whichever you have a signer for. On Solana, the seller's facilitator covers SOL gas — buyer wallet only needs USDC.
- Federated discovery: `pay.discover` queries the curated `seed.json` + CDP Bazaar + agentic.market + x402watch in parallel and dedupes by canonical endpoint URL
- Spend caps, host allowlist, receipts log, self-transfer guard — protocol-agnostic
- Confirm-before-pay via MCP elicitation, with graceful fallback for clients lacking task-creation support (Claude Code)
- Apache 2.0, DCO not CLA

## Quickstart

Two steps. You need Node 20+ and a wallet funded with USDC on whichever chain you want to pay on.

### 1. Set at least one wallet key in your environment

For Base / EVM:

```bash
export X402_PAYER_PRIVATE_KEY=0x...
```

0x-prefixed 64-hex-char private key. Fund the wallet with at least `$0.01 USDC` on Base mainnet.

For Solana:

```bash
export X402_PAYER_SOLANA_KEY=<base58 secret key>
```

Accepts either base58 (Phantom's "Show Private Key" export) or the JSON-array format `solana-keygen new` writes. Fund the wallet with at least `$0.01 USDC` (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) on Solana mainnet. **Buyer wallet does not need SOL** — facilitators cover network fees as the transaction's `feePayer`.

You can configure either, both, or neither. With neither, the gateway boots and lists tools but can't pay anything. With both, sellers offering multi-chain options are routed by accept order (typically EVM first); to force a specific chain, configure only that key.

Use a fresh wallet, not your main one. (You can also pass these via your MCP client's `env` block — see below.)

### 2. Register the gateway with your MCP client

**Claude Code (CLI):**

```bash
claude mcp add x402-pay -- npx -y thebuyside-x402-agent
```

Open a session, type `/mcp` to verify, then ask: *"Use pay.wallet_status to show my wallet."*

**Claude Desktop:**

See [docs/install-claude-desktop.md](docs/install-claude-desktop.md).

> Local stdio MCP servers can only be reached by **local** MCP clients (Claude Code CLI, Claude Desktop). The claude.ai web app's "Code" mode runs in Anthropic's cloud and can't reach a server on your laptop.

## Try it

Once connected, ask the model:

> *"Use pay.discover to find APIs about news."*

> *"Use pay.fetch to get https://news-ep.com/api/v1/stories?market=houston&limit=5"*

The first returns the registry plus federated matches from CDP Bazaar, agentic.market, and x402watch (each result tagged with its `source`). The second pays `$0.005 USDC` and returns Houston news. news-ep advertises both Base and Solana — the gateway picks whichever chain you have a key for.

After a successful call, ask `pay.wallet_status` and you'll see today's spend reflected (and which chains have signers configured).

## Configuration

Spend controls have safe defaults. Override via env if needed.

**Wallet keys** (configure at least one to pay):

| Var | Default | What it does |
| --- | --- | --- |
| `X402_PAYER_PRIVATE_KEY` | *(unset)* | Base / EVM private key (0x-prefixed, 64 hex chars) |
| `X402_PAYER_SOLANA_KEY` | *(unset)* | Solana secret key — base58 (Phantom export) or JSON-array (`solana-keygen`) format |
| `X402_SOLANA_RPC` | `api.mainnet-beta.solana.com` | Solana RPC for fetching a recent blockhash at sign time |

**Spend caps and confirm-before-pay:**

| Var | Default | What it does |
| --- | --- | --- |
| `X402_DAILY_LIMIT` | `1.00` | Max USDC spent per rolling 24h window |
| `X402_PER_CALL_LIMIT` | `0.05` | Max USDC per single call |
| `X402_ALLOWLIST` | hosts in `seed.json` | Comma-separated allowed hostnames (replaces default) |
| `X402_ALLOW_UNVERIFIED` | *(off)* | `1` allows any host — dev only |
| `X402_REQUIRE_CONFIRM` | `always` | `always`, `never`, or a USDC threshold (e.g. `0.01`). Asks the user to approve via MCP elicitation before signing |
| `X402_CONFIRM_STRICT` | *(off)* | `1` refuses payment when the client lacks elicitation OR advertises elicitation but lacks tasks/create (e.g. Claude Code as of 2026-05). Default: log a one-time warning and proceed |
| `X402_RECEIPTS_PATH` | `.local/receipts.jsonl` | Where the receipts log is written |

**Federated discovery** (`pay.discover` queries these in parallel and merges with the local `seed.json`):

| Var | Default | What it does |
| --- | --- | --- |
| `X402_FEDERATION` | `on` | `off` disables all external indexes; discover returns local-only results |
| `X402_FEDERATION_TIMEOUT_MS` | `1500` | Per-source timeout. A slow source produces zero entries (and a warning), never blocks discover |
| `X402_BAZAAR_URL` | `api.cdp.coinbase.com/platform/v2/x402/discovery/search` | CDP Bazaar endpoint override |
| `X402_AGENTIC_URL` | `api.agentic.market/v1/services/search` | agentic.market endpoint override |
| `X402_X402WATCH_URL` | GitHub raw snapshot URL | x402watch daily snapshot URL (the `{date}` placeholder is filled at request time) |
| `X402_DISABLE_BAZAAR` | *(off)* | `1` skips CDP Bazaar |
| `X402_DISABLE_AGENTIC` | *(off)* | `1` skips agentic.market |
| `X402_DISABLE_X402WATCH` | *(off)* | `1` skips x402watch |

**Dev / test:**

| Var | Default | What it does |
| --- | --- | --- |
| `X402_TEST_URL` | news-ep stories | Override target for `pnpm pay-newsep` and `pnpm pay-solana` |

Limit values accept either decimal USDC (`0.05`) or atomic units (`50000`). See [docs/configuring-spend-limits.md](docs/configuring-spend-limits.md) for the full spend-controls guide.

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
                  │  HTTPS GET → 402 challenge → pick chain by signer →
                  │             EVM: EIP-3009 typed-data sign  ─┐
                  │             SVM: partial-sign Solana tx    ─┤
                  │             → retry with PAYMENT-SIGNATURE  │
                  │             → 200 + body                    │
            ┌─────▼──────┐         ┌──────────────────┐         │
            │ x402 server│ ──────→ │ Facilitator      │ ─→ chain settle
            │ (e.g.      │         │ (verify + submit │     (Base USDC
            │  news-ep)  │ ←────── │  tx)             │      or Solana USDC)
            └────────────┘         └──────────────────┘
```

The gateway holds the wallet(s), drives the 402 → sign → 200 loop, picks the right chain adapter per challenge, enforces spend caps, and writes a receipts log. The agent stays at the MCP layer and never deals with payment plumbing.

## Run from source

For contributors and anyone who wants to hack on the gateway:

```bash
git clone https://github.com/jaysperspective/thebuyside-x402-agent.git
cd thebuyside-x402-agent
pnpm install
cp .env.example .env   # then paste your key into X402_PAYER_PRIVATE_KEY
```

Useful scripts:

- **`pnpm pay-newsep`** — standalone script that pays news-ep `$0.005` on Base end-to-end without MCP. Verifies your EVM wallet + protocol setup.
- **`pnpm pay-solana`** — same idea on Solana. Registers ONLY the Solana adapter so it routes via SVM even when the seller offers Base too. Defaults to a target that advertises Solana; override with `X402_TEST_URL`.
- **`pnpm smoke`** — spawns the MCP server in a subprocess and round-trips a few tool calls. CI-safe; no real payments.
- **`pnpm verify-seed`** — hits each registry entry's example URL and asserts a valid 402 with the advertised price. Run nightly in CI.
- **`pnpm test`** — the full vitest unit-test suite (154 tests as of v0.5.0).
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
