---
name: near402
description: Pay-per-token private AI inference over HTTP 402 using NEAR or NEAR Intents (1Click). Use when an agent needs to call an OpenAI-compatible NEAR402 proxy without API keys or accounts.
---

# near402 (Sipx) — Pay-Per-Token Private AI Inference

Call any `near402` OpenAI-compatible endpoint (`POST /v1/chat/completions`) and automatically pay HTTP `402 Payment Required` challenges using your NEAR wallet or NEAR Intents 1Click.

## Zero-Config Setup (CLI, Harness Bridge, or Node.js / TypeScript)

```bash
npm install near402
npx near402 use http://localhost:4020
npx near402 fund                 # auto-creates wallet, claims free trial if available, or prints ?fund= link
npx near402 serve --port 4021    # universal local OpenAI bridge (OPENAI_BASE_URL=http://127.0.0.1:4021/v1)
```

Or use `npx near402 chat "..."` directly (auto-inits wallet and auto-claims starter trial when available). When funding an unactivated implicit account with USDC, include `>= 0.02 NEAR` for gas (`/playground?fund=<accountId>` bundles this automatically) or provision a NEAR Gas Key via `near402 key provision --mode gas_key_full`.

Or embed `createNear402Fetch` in any Node/TS SDK (`near402/pi` is also exported for Pi extensions):

```ts
import { createNear402Fetch } from "near402";

const fetch402 = createNear402Fetch({
  accountId: process.env.NEAR_ACCOUNT_ID,
  privateKey: process.env.NEAR_PRIVATE_KEY,
  preferredAsset: "USDC", // or "NEAR"
});

const res = await fetch402("http://localhost:4020/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
    messages: [{ role: "user", content: "Hello from a paying agent!" }],
  }),
});
console.log(await res.json());
```

## Raw HTTP 402 Protocol Flow (Any Language / Agent)

1. `POST /v1/chat/completions` without an `Authorization` header (or with an exhausted `near402_...` token).
2. Proxy returns `402 Payment Required` with `challenge`:
   - `rails.nearDirect`: `recipient`, accepted `USDC` NEP-141 contract (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) and native `NEAR` amount.
   - `rails.nearIntents`: `quoteUrl` (`POST /v1/402/quote`) for cross-chain 1Click swaps.
3. Pay once (direct NEAR transfer / `ft_transfer` OR 1Click deposit) and call `POST /v1/402/redeem`:
   - Direct NEAR: `{ "rail": "near_direct", "txHash": "...", "senderAccountId": "agent.near" }`
   - 1Click Intents: `{ "rail": "near_intents", "depositAddress": "..." }` (poll while `202` until `200`)
4. Save the returned `token` (`near402_...`) and pass `Authorization: Bearer <token>` on subsequent OpenAI-compatible requests until balance is spent.
5. Verify TEE hardware provenance anytime via `GET /v1/attestation/report?model=...` and `GET /v1/signature/{chat_id}?model=...`.

