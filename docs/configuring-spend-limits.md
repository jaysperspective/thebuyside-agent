# Configuring spend limits

The gateway ships with conservative defaults so a fresh install genuinely cannot drain your wallet — you have to opt up explicitly.

## Defaults at a glance

| Limit | Default | Where it lives |
| --- | --- | --- |
| Per-call cap | `$0.05 USDC` | `X402_PER_CALL_LIMIT` env var |
| Daily cap | `$1.00 USDC` per rolling 24h | `X402_DAILY_LIMIT` env var |
| Host allowlist | hosts in `src/registry/seed.json` | `X402_ALLOWLIST` env var |
| Allow-any override | off | `X402_ALLOW_UNVERIFIED=1` |

A fresh install with a funded wallet, no other env tweaks, can spend at most `$1.00/day` to hosts in the curated registry. Worst case if an LLM agent goes haywire: `$1.00`.

## Per-call cap

Refuses any single payment whose amount exceeds the cap.

```bash
# in .env
X402_PER_CALL_LIMIT=0.05      # decimal USDC
# or equivalently:
X402_PER_CALL_LIMIT=50000     # atomic units (6 decimals)
```

## Daily cap (sliding 24h window)

Sums the `amount_atomic` values from `~/thebuyside-agent/.local/receipts.jsonl` for the last 24 hours. If the new payment would push the total over the cap, the gateway refuses with a clear error citing the running total.

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

Every settled payment appends a line to `~/thebuyside-agent/.local/receipts.jsonl`:

```json
{"id":"...","ts":"2026-05-10T02:10:14.123Z","host":"news-ep.com","url":"https://news-ep.com/api/v1/stories?...","method":"GET","amount_atomic":"5000","asset":"USDC","chain":"base","tx_hash":"0xd091..."}
```

The daily cap reads this file. To override the path (e.g. for shared logs across hosts):

```bash
X402_RECEIPTS_PATH=/var/log/thebuyside-agent/receipts.jsonl
```

## Self-transfer guard

The gateway refuses to sign if your payer wallet's derived address equals the seller's `payTo` (typically because you accidentally configured the seller's receiving wallet as your buyer key). This is non-configurable — it catches a real misconfig that would otherwise produce confusing CDP rejections.

## What's NOT a control

- **Confirm-before-pay**: the gateway does not interrupt to ask the user "really pay $X?" Future versions may use MCP elicitation when client support is universal. For now, rely on the caps.
- **Per-host budgets**: each host counts against the same daily cap. Per-host caps are a v0.x feature.
- **Time-of-day limits**: no quiet-hours feature. Workaround: stop the gateway via your MCP client config when you don't want it running.
