# MPP implementer notes

Notes for engineers implementing the **Machine Payments Protocol** (`solana`/`charge` intent) per [paymentauth.org/draft-solana-charge-00](https://paymentauth.org/draft-solana-charge-00.html). Both sides — buyer client and seller server — should find this useful.

## Status

The first cross-implementation MPP-Solana settlement we're aware of happened on **2026-05-11** between two independent implementations:

- **Buyer** — JavaScript / TypeScript, this repo (`thebuyside-x402-agent` on npm), built on `@solana/web3.js` + `@solana/spl-token`.
- **Seller** — Python / FastAPI, [news-ep.com](https://news-ep.com), built on `solders` + a custom ASGI middleware.

Reference settlement tx: [`3UzJ7Uz…LJmG`](https://solscan.io/tx/3UzJ7UzhyLwAAFf5Jsnf5jcW9pXUV1BzDswnuxyvNvUgJXnorS5Moozb4fdnqCyy3fwPNLk5jYkqiX8USdpDLJmG) — 1000 atomic USDC ($0.001), buyer-signed, seller-cosigned as feePayer, finalized on Solana mainnet.

The spec round-trips cleanly between a JS buyer and a Python seller. What follows is what we wish we'd known before we started.

## Wire format quick reference

### Discovery (server → client)

On a 402, the server emits an RFC 7235 `WWW-Authenticate` header advertising the `Payment` scheme:

```
HTTP/2 402
content-type: application/problem+json
www-authenticate: Payment id="<challenge-id>", realm="<request-host>",
  method="solana", intent="charge",
  request="<base64url(JCS(ChargeRequest))>",
  expires="<ISO-8601>",
  description="<optional human label>"
access-control-expose-headers: www-authenticate, payment-receipt
```

All auth-param values are quoted strings (RFC 7235 §2.1). The `request` value is the actual payment terms, JCS-canonicalized JSON ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) then base64url-encoded:

```json
{
  "amount": "1000",
  "currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "description": "...",
  "methodDetails": {
    "decimals": 6,
    "feePayer": true,
    "feePayerKey": "<server's facilitator pubkey, base58>",
    "network": "mainnet",
    "recentBlockhash": "<from getLatestBlockhash>",
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  },
  "recipient": "<seller's receive pubkey, base58>"
}
```

Keys MUST be alphabetically sorted by JCS. The challenge expires in ~60s; cache a fresh blockhash on the server side to absorb the per-request RPC cost.

### Credential (client → server)

```
GET /resource HTTP/2
authorization: Payment <base64url(JCS(Credential))>
```

```json
{
  "challenge": {
    "expires": "...",
    "id": "...",
    "intent": "charge",
    "method": "solana",
    "realm": "...",
    "request": "<echo the original base64url-JCS string verbatim>"
  },
  "payload": {
    "transaction": "<base64 of partially-signed Solana VersionedTransaction>",
    "type": "transaction"
  },
  "source": "<buyer's Solana pubkey, base58>"
}
```

Keys alphabetically sorted. **Echo the original `request` string verbatim** — do not re-canonicalize the decoded ChargeRequest. Subtle byte differences between your JCS and the server's JCS will fail replay-mark lookups.

### Receipt (server → client, on 200)

```
HTTP/2 200
content-type: application/json
payment-receipt: <base64url(JCS(PaymentReceipt))>

<resource body>
```

```json
{
  "amount": "1000",
  "challengeId": "...",
  "currency": "EPjFWdd5...",
  "network": "mainnet",
  "recipient": "...",
  "settledAt": "<ISO-8601>",
  "slot": <number>,
  "source": "...",
  "txSignature": "<base58 Solana signature>"
}
```

`txSignature` is independently verifiable on-chain — that's where receipt authenticity ultimately rests. The envelope itself is not signed in v0.

## Pitfalls we hit during pair-test

Four real bugs surfaced while validating end-to-end. Each is a tripwire that's easy to miss in spec reading but hard to ignore once you're trying to settle live.

### 1. RFC 7235 multi-challenge on a 402 (coexistence with x402)

If your endpoint already serves x402 and you're adding MPP, **emit both challenges on the bare 402** (no Authorization header) and let the client pick by which `Authorization` scheme it returns. Don't gate MPP advertisement on the client first sending an `Authorization: Payment <probe>` header — that violates RFC 7235's "server advertises, client chooses" flow and means MPP-only clients can't discover MPP through your endpoint.

Concrete shape:

```
HTTP/2 402
payment-required: <base64-x402-v2-challenge>             # x402's existing header
www-authenticate: Payment id="...", method="solana", ... # MPP's challenge
access-control-expose-headers: www-authenticate, payment-required, payment-receipt
```

A buyer's choice is signaled on the retry: `Authorization: X-PAYMENT …` (x402) vs `Authorization: Payment …` (MPP).

Implementation cost: a ~30s in-process cache for `getLatestBlockhash` keeps the per-request RPC cost flat when you mint an MPP challenge on every paywalled 402.

### 2. Strict tx instruction whitelist — no memo

MPP's verify rejects unknown programs. A common x402-SVM convention is to append a Memo instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) carrying a facilitator-correlation nonce. In MPP, **don't include the memo** — correlation happens via `challenge.id` echoed in the credential, and the extra program fails the verifier:

```
402 detail: "Verification failed: unexpected program in transaction: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
```

Allowed instructions on the buyer-built tx: a ComputeBudget prefix (`SetComputeUnitLimit` / `SetComputeUnitPrice`) for priority fees, then exactly one `transferChecked` under the standard SPL Token Program. Servers should walk instructions and ignore ComputeBudget entries when counting transfers.

### 3. solders `bytes(MessageV0)` is not the v0-prefixed form (Python sellers)

On the server side, if you're using `solders` and call `Signature.verify(buyer_pub, bytes(msg))` to check the buyer's signature, you'll get `False` on a valid signature. `bytes(MessageV0)` in `solders` 0.27.x returns the **299-byte legacy form** without the `0x80` version prefix — but `@solana/web3.js` (and the Solana spec) signs over the **300-byte versioned form** that starts with `0x80`.

Use `solders.message.to_bytes_versioned(msg)` everywhere you sign or verify. Symptom: `"Verification failed: buyer signature failed verification"` on a credential whose signature you can verify locally with nacl.

### 4. Middleware-onion ordering — bypass on success path

If MPP middleware sits **outside** another payment middleware in your ASGI stack (e.g. x402's), the success path's `call_next(request)` will re-enter the inner middleware, which doesn't know the buyer already paid and will return its own 402. Your MPP middleware then dutifully tacks a `Payment-Receipt` header onto that 402 body and returns it. From the client's perspective: settlement happens on-chain, no 200 is returned, and the article isn't delivered. Worst-case UX for a paid API.

Fix: a flag like `request.state.mpp_settled = True` set right before `call_next` on the MPP success path, plus a subclass of the inner middleware that bypasses enforcement when the flag is set. Affects only requests that already paid via MPP; x402 buyers and non-paying requests are unchanged.

## Reference behavior to test against

Bytes from the reference settlement (`challengeId zMDvqJsRhzLnXDAVoyrP_w`, immediately preceding the successful one):

- buyer pubkey (base58): `5Quv32NFLRPvZGtuGrT9AGasz6U8x29jF6kxLCeFznrz`
- buyer signature (hex): `0c1e61ce5b55b81218bcaa07a754b1f88fce2abaa2667b2566a70c3469003e06f406b40f3c08adcc1f3b40f55db00bd0ba9b447f681625d3bae77ecb821dfc0d`
- message bytes (hex, 300 bytes, v0): `80020103077c3ffe3aec5c4e1d3734e6df924acc440e126eb2820d951b9a13296f663cb37b418eefd2d6b73bdccb1028edeab4eb6b924950a5204cc9d567e8cb3ebb6e69cfb77f1abc93f50a84420cb15025aa5d66191acc08f873c6d08cbae4e0bb2caa5529f302fd00354353e4402f0e221a584f12138c25330da4775367e3fe265f5b8d0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a4000000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61c42f609bdc0fc324387b0ef54fd721a0c1087e512d3262ea20046dcd03f2ce18030400050260ea000004000903e8030000000000000504020603010a0ce8030000000000000600`

`nacl.sign.detached.verify(msg, sig, pub)` (JS, Python `solders.Signature.verify(pub, msg)`, or any compliant ed25519 verifier) MUST return `True` for these three inputs. If yours doesn't, the bug is in your message-bytes computation — that's how we caught the `bytes(msg)` vs `to_bytes_versioned(msg)` divergence (pitfall 3).

## Reference implementations

- **Buyer (JS/TS)** — `src/mpp/` in this repo:
  - `auth-header.ts` — RFC 7235 `Payment`-scheme parser/builder
  - `jcs.ts` — RFC 8785 JSON canonicalization
  - `types.ts` — wire types
  - `client.ts` — protocol loop with `beforePay`/`onPaid` policy hooks
  - `src/chains/solana-usdc.ts:buildPaymentMpp` — partially-signed VersionedTransaction builder
  - `scripts/pay-mpp.ts` — standalone live-test runner. Set `X402_MPP_DEBUG=1` to dump signed-tx internals (signer keys, message hex, signature hex) for byte-diffing with a seller.
- **Seller (Python/FastAPI)** — news-ep.com. Not open-source, but the spec-level wire shape they emit is documented above. Their ASGI middleware uses `solders` + Redis SET NX for replay protection.

If you implement MPP support and want to interop-test, we're a known-good counterparty — `pnpm pay-mpp <your-url>` against a Solana mainnet endpoint, with a funded test wallet (`X402_PAYER_SOLANA_KEY`).
