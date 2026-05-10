# Adding an x402-priced API to the registry

The discover tool reads from `src/registry/seed.json` — a curated, hand-verified list of x402-priced endpoints. Adding a new entry is one PR.

## Rules of the road

- **Verified entries only.** An entry only goes into `seed.json` if it currently returns a valid 402 challenge with the price the entry claims. Unverified candidates go in `seed.candidates.json` until proven.
- **One entry, one endpoint.** Don't combine multiple endpoints into a single entry. The discover tool's job is to surface the right *call*, not the right vendor.
- **No self-promotion blurbs.** The `description` field describes what the API does, not why it's great. Reviewers will trim.
- **Tags should help an LLM match queries.** Be generous and concrete. `["news", "houston", "local"]` is good. `["amazing", "powerful"]` is not.

## Schema

See [src/registry/types.ts](../src/registry/types.ts) for the canonical types. Each entry in `seed.json`'s `entries` array looks like:

```json
{
  "id": "your-api-name-action",
  "name": "Your API — short human-readable name",
  "description": "What this endpoint does. One or two sentences.",
  "endpoint": "https://api.example.com/v1/things",
  "method": "GET",
  "price_usdc": 0.005,
  "price_atomic": 5000,
  "chain": "base",
  "network": "eip155:8453",
  "category": "weather",
  "tags": ["weather", "forecast", "city", "global"],
  "example": "https://api.example.com/v1/things?city=Houston",
  "verified": true,
  "verified_at": "2026-05-10"
}
```

### Field notes

- **`id`** — unique kebab-case. Convention: `<vendor>-<resource>-<action>`. Example: `newsep-stories-search`, `acme-weather-current`.
- **`endpoint`** — full URL. May contain `{placeholder}` segments for path parameters (e.g. `/items/{id}`). If you use placeholders, you **must** also provide an `example` URL the verifier can hit.
- **`price_usdc` and `price_atomic`** — must be consistent. USDC has 6 decimals, so `price_atomic = price_usdc × 1_000_000`. Both fields exist because humans read the first and programs read the second.
- **`chain`** — short id. Currently `"base"`. Solana support arrives in a later version.
- **`network`** — CAIP-2 form. Base mainnet is `"eip155:8453"`. Match what the server's 402 challenge actually emits.
- **`tags`** — lowercase, no punctuation. Aim for 5-10 keywords that would appear in user prompts.
- **`example`** — a fully-resolved URL with sample params. Used by `verify-seed` and shown to the LLM as a hint.

## How to submit

1. **Verify the endpoint manually first:**

   ```bash
   curl -i "https://api.example.com/v1/things?city=Houston"
   ```

   Confirm the response is `HTTP/x 402` and that the price + payTo match what you'll put in the entry.

2. **Add your entry** to `src/registry/seed.json`'s `entries` array.

3. **Run the local verifier:**

   ```bash
   pnpm verify-seed
   ```

   This hits the `example` URL of every entry and asserts a 402 with the advertised price. Yours should pass.

4. **Open a PR.** CI runs `verify-seed` again on the PR; if your entry breaks, you'll see why.

## Candidates list (`seed.candidates.json`)

If you know an endpoint exists but can't currently verify it (e.g. it's announced for a future date, or it's behind an allowlist), add it to `seed.candidates.json` instead of `seed.json`. The verify-seed script doesn't fail on candidates — they're a watchlist for a maintainer to promote later.

```json
{
  "version": 1,
  "entries": [
    {
      "id": "future-api-things",
      "name": "Future API — things",
      "endpoint": "https://future.example.com/api/things",
      ...
      "verified": false,
      "verified_at": "2026-05-10"
    }
  ]
}
```

## Removing a stale entry

Open a PR that removes the entry. CI's `verify-seed` job will be happy. Ideally include a one-line note in the PR description explaining what changed (vendor sunset, price changed, endpoint deprecated, etc.) so future maintainers have context.

## DCO sign-off

We use the [Developer Certificate of Origin](https://developercertificate.org/) — sign your commits with `git commit -s`. No CLA paperwork.
