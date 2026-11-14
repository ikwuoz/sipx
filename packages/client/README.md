# `sipx402`

**Zero-config HTTP 402 buyer SDK, OpenAI bridge & CLI for verifiable private AI inference on NEAR.**

Pay HTTP `402 Payment Required` challenges once via NEAR (`USDC` / `NEAR`) or NEAR Intents 1Click, cache your signed `near402_...` session token, and stream hardware TEE-attested inference from [NEAR AI Cloud](https://cloud.near.ai).

**[Live Playground](https://sipx-production.up.railway.app/playground)** · **[Live Proxy](https://sipx-production.up.railway.app/health)** · **[GitHub Repo](https://github.com/ikwuoz/sipx)**

---

## Quickstart (CLI & Universal Harness Bridge)

```bash
npm install -g sipx402                              # or prefix commands with npx sipx402
sipx402 use https://sipx-production.up.railway.app
sipx402 fund                                        # auto-inits wallet, claims $0.02 trial, checks NEAR gas
sipx402 chat "Explain NEAR Intents in 1 sentence"
```

Run an OpenAI-compatible loopback bridge for **`pi`**, **Codex CLI**, **Cursor**, **Claude Code**, or Python SDKs:

```bash
sipx402 serve --port 4021                           # http://127.0.0.1:4021/v1
```

Set `OPENAI_BASE_URL=http://127.0.0.1:4021/v1` and `OPENAI_API_KEY=near402`. For Pi extensions, import `sipx402/pi` (`registerPiNear402`).

---

## TypeScript / OpenAI SDK + TEE Verification

```ts
import OpenAI from "openai";
import { createNear402Fetch, verifyChatProof } from "sipx402";

const client = new OpenAI({
  baseURL: "https://sipx-production.up.railway.app/v1",
  apiKey: "near402",
  fetch: createNear402Fetch({
    accountId: process.env.NEAR_ACCOUNT_ID!,
    privateKey: process.env.NEAR_PRIVATE_KEY as `ed25519:${string}`,
    preferredAsset: "auto",
    spendPolicy: {
      maxPerPaymentUsd: 0.25,
      maxHourlyUsd: 1.0,
      maxDailyUsd: 5.0,
    },
  }),
});

const res = await client.chat.completions.create({
  model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
  messages: [{ role: "user", content: "Hello private TEE world!" }],
});
console.log(res.choices[0].message.content);
```

---

## Security & Spend Controls

- **Encrypted Keystore (`AES-256-GCM` + `scrypt`):** `sipx402 init --encrypt` / `sipx402 wallet encrypt`
- **Scoped NEAR Gas Keys:** `sipx402 key provision --owner you.near --owner-key ed25519:... --save` · `sipx402 key status` · `sipx402 key revoke`
- **Spend Guardrails:** Per-payment, rolling `1h`/`24h`, lifetime, origin & recipient allowlists via `spendPolicy` (`sipx402 spend`)
- **0-Gas USDC Protection:** Detects unactivated / low-NEAR accounts holding USDC and raises `InsufficientGasError` before attempting `ft_transfer`.
