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
| **M0** | Standalone script pays news-ep $0.005 USDC end-to-end. No MCP. | 🟡 in progress |
| **M1** | MCP server with stub tools shows up in Claude Desktop. | ⏳ |
| **M2** | M1 + M0 wired together. End-to-end paid call from Claude. | ⏳ |
| **M3** | Wallet status tool, seed list, install docs, CI verify. | ⏳ |

## M0 — pay news-ep manually

A standalone TypeScript script that drives the full x402 loop against [news-ep.com](https://news-ep.com): `GET /api/v1/stories` → 402 challenge → EIP-3009 signed payment → `200` with the article body. Settlement happens on Base mainnet via the Coinbase CDP facilitator.

### Prerequisites

- Node ≥20, pnpm ≥10
- A Base-mainnet self-custody wallet (MetaMask, Coinbase Wallet, or any EVM wallet) — **do not reuse a key with significant funds**
- ~$0.10 of USDC on Base in that wallet (one M0 call costs $0.005)

### Run

```bash
pnpm install
cp .env.example .env
# paste your wallet's private key into X402_PAYER_PRIVATE_KEY
pnpm pay-newsep
```

You should see:

```
payer: 0xYourWallet
target: https://news-ep.com/api/v1/stories?market=dmv&limit=1
→ GET (no payment)
  402 received. price: 5000 atomic, payTo: 0xc8Ca…1540C
→ signing EIP-3009 transferWithAuthorization
  signature: 0xabcd…
→ GET (with X-PAYMENT)
  status: 200
--- response body ---
{ "stories": [...] }
```

The settlement transaction will appear on [basescan.org](https://basescan.org) under the receiving wallet (`0xc8CaE186fb4f382D3DD9C82cbA976C255531540C`).

## License

[Apache License 2.0](./LICENSE).
