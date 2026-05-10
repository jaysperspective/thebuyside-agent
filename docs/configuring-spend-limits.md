# Configuring spend limits

The gateway ships with conservative defaults so a fresh install genuinely cannot drain your wallet — you have to opt up explicitly.

## Defaults at a glance

| Limit | Default | Where it lives |
| --- | --- | --- |
| Per-call cap | `$0.05 USDC` | `X402_PER_CALL_LIMIT` env var |
| Daily cap | `$1.00 USDC` per rolling 24h | `X402_DAILY_LIMIT` env var |
| Host allowlist | hosts in `src/registry/seed.json` | `X402_ALLOWLIST` env var |
| Allow-any override | off | `X402_ALLOW_UNVERIFIED=1` |
| Confirm before pay | always (when client supports it) | `X402_REQUIRE_CONFIRM` env var |

A fresh install with a funded wallet, no other env tweaks, can spend at most `$1.00/day` to hosts in the curated registry, and every payment prompts the user via MCP elicitation before signing. Worst case if an LLM agent goes haywire AND every prompt is approved without thinking: `$1.00`.

## Per-call cap

Refuses any single payment whose amount exceeds the cap.

```bash
# in .env
X402_PER_CALL_LIMIT=0.05      # decimal USDC
# or equivalently:
X402_PER_CALL_LIMIT=50000     # atomic units (6 decimals)
```

## Daily cap (sliding 24h window)

Sums the `amount_atomic` values from `<project>/.local/receipts.jsonl` for the last 24 hours. If the new payment would push the total over the cap, the gateway refuses with a clear error citing the running total.

```bash
X402_DAILY_LIMIT=1.00          # decimal USDC
# or:
X402_DAILY_LIMIT=1000000       # atomic units
```

The window is *rolling*, not calendar-day. A spike at 23:59 doesn't reset at midnight.

## Host allowlist

Default allowlist is the set of hostnames extracted from `src/registry/seed.json`. To add hosts that aren't in the registry yet:

```bash
X402_ALLOWLIST=news-ep.com,api.example.com,weather.example.com
```

`X402_ALLOWLIST` *replaces* the default — include all hosts you want allowed, separated by commas.

## Bypass for development

If you're testing against a local/private x402 server not in the registry:

```bash
X402_ALLOW_UNVERIFIED=1
```

This disables the host allowlist check entirely. **Don't ship this in production** — pair it with a tight per-call cap if you must use it.

## Receipts log

Every settled payment appends a line to `<project>/.local/receipts.jsonl`:

```json
{"id":"...","ts":"2026-05-10T02:10:14.123Z","host":"news-ep.com","url":"https://news-ep.com/api/v1/stories?...","method":"GET","amount_atomic":"5000","asset":"USDC","chain":"base","tx_hash":"0xd091..."}
```

The daily cap reads this file. To override the path (e.g. for shared logs across hosts):

```bash
X402_RECEIPTS_PATH=/var/log/thebuyside-x402-agent/receipts.jsonl
```

## Self-transfer guard

The gateway refuses to sign if your payer wallet's derived address equals the seller's `payTo` (typically because you accidentally configured the seller's receiving wallet as your buyer key). This is non-configurable — it catches a real misconfig that would otherwise produce confusing CDP rejections.

## Confirm before pay (MCP elicitation)

Before signing any payment, the gateway sends an [MCP elicitation request](https://modelcontextprotocol.io/specification/draft/client/elicitation) to your client showing the destination, amount, resource, and today's running spend. Approving signs and pays. Declining or cancelling aborts with a clear error to the agent.

```
X402_REQUIRE_CONFIRM=always
X402_REQUIRE_CONFIRM=never
X402_REQUIRE_CONFIRM=0.01
```

`always` (default) confirms every payment; `never` skips confirmation entirely (caps remain the only gate); a USDC threshold like `0.01` confirms only at or above that amount. Numeric values accept either decimal (`0.01`) or atomic units (`10000`).

### Seller trust signals in the prompt

When a seller bakes metadata into the 402 challenge's `extensions` field (CDP Bazaar listings do this), the gateway renders it on a dedicated line in the prompt. The `bazaar` namespace gets a structured render:

```
Confirm payment to news-ep.com
  Amount:   $0.005000 USDC (Base mainnet)
  Resource: GET /api/v1/stories?market=houston&limit=5
  Today:    $0.005000 of $1.000000 daily cap
  Bazaar:   EP News • category: news • listing: bz_abc123
```

Other namespaces get a generic flat key=value list (max 3 entries, string/number values only — nested-object spam is dropped). This gives you a trust signal beyond the bare URL and amount.

### When the client doesn't fully support elicitation

Two fallback paths, both share the same warn-and-proceed-or-fail-closed switch:

1. **Client never declared elicitation capability** (older clients, some IDE plugins). The gateway logs `client does not support MCP elicitation; payments will proceed without per-call confirmation (caps still enforced)` once and proceeds.

2. **Client advertised elicitation but lacks `tasks/create`** under the hood — this is Claude Code's case as of 2026-05. The first call surfaces an `MCP error -32603: Client does not support task creation` from `elicitInput`; the gateway recognizes that pattern and falls through to the same one-time-warning path: `client advertised elicitation but lacks tasks/create; payments will proceed without per-call confirmation (caps still enforced)`.

Both paths are fail-open-but-bounded — caps + allowlist still enforce the spending ceiling.

To make either case fail closed instead:

```
X402_CONFIRM_STRICT=1
```

In strict mode, the gateway refuses any payment when the client can't prompt — regardless of which fallback path applied. Recommended only if your client definitely supports elicitation end-to-end and you want a hard guarantee.

The 30-second elicitation TTL means an unanswered prompt times out and is treated as a decline.

## What's NOT a control

- **Per-host budgets**: each host counts against the same daily cap. Per-host caps are a v0.x feature.
- **Time-of-day limits**: no quiet-hours feature. Workaround: stop the gateway via your MCP client config when you don't want it running.
