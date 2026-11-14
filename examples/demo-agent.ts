/**
 * Minimal autonomous buyer agent demo for Sipx (near402).
 *
 * Usage:
 *   NEAR_ACCOUNT_ID=your-agent.near NEAR_PRIVATE_KEY=ed25519:... \
 *   NEAR402_PROXY_URL=http://localhost:4020 \
 *   node examples/demo-agent.ts
 */
import {
  createNear402Fetch,
  DEFAULT_MODEL_ID,
  loadWallet,
  verifyChatProof,
} from "../packages/client/dist/index.js";

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional
}

const proxyUrl = (process.env.NEAR402_PROXY_URL || "http://localhost:4020").replace(
  /\/+$/,
  "",
);
const envAccountId = process.env.NEAR_ACCOUNT_ID;
const envPrivateKey = process.env.NEAR_PRIVATE_KEY as `ed25519:${string}` | undefined;
const storedWallet = !envAccountId || !envPrivateKey ? loadWallet() : null;
const accountId = envAccountId || storedWallet?.accountId;
const privateKey = envPrivateKey || storedWallet?.privateKey;

if (!accountId || !privateKey) {
  console.error(
    "Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY (or run `npx near402 init --encrypt`)",
  );
  process.exit(1);
}

const fetch402 = createNear402Fetch({
  accountId,
  privateKey,
  keyType: storedWallet?.keyType,
  network: process.env.NEAR_NETWORK === "testnet" ? "testnet" : "mainnet",
  preferredAsset: (process.env.NEAR402_ASSET as "auto" | "USDC" | "NEAR") || "auto",
  rail: (process.env.NEAR402_RAIL as "near_direct" | "near_intents") || "near_direct",
  spendPolicy: {
    maxPerPaymentUsd: Number(process.env.NEAR402_MAX_PER_PAYMENT_USD || 0.5),
    maxDailyUsd: Number(process.env.NEAR402_MAX_DAILY_USD || 2.0),
  },
  onPayment: (receipt) => {
    console.log(
      `[agent] 402 settled: +$${receipt.creditedUsd.toFixed(4)} via ${receipt.rail} (tx: ${receipt.txRef})`,
    );
  },
});

const model = process.env.NEAR402_MODEL || DEFAULT_MODEL_ID;
const requestBody = JSON.stringify({
  model,
  max_tokens: 512,
  messages: [
    {
      role: "user",
      content: "In one sentence, explain why HTTP 402 + NEAR Intents unlocks agent economies.",
    },
  ],
});

console.log(`[agent] Calling ${proxyUrl}/v1/chat/completions (${model})...`);

const res = await fetch402(`${proxyUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: requestBody,
});

if (!res.ok) {
  console.error(`Error ${res.status}:`, await res.text());
  process.exit(1);
}

const chatId = res.headers.get("x-near-chat-id");
const upstreamRequestHash = res.headers.get("x-near402-request-sha256") ?? undefined;
const costUsd = res.headers.get("x-near402-cost-usd");
const balanceUsd = res.headers.get("x-near402-balance-usd");
const rawResponseBody = await res.text();
const data = JSON.parse(rawResponseBody) as {
  choices?: Array<{ message?: { content?: string } }>;
};

console.log("\nResponse:", data.choices?.[0]?.message?.content);
console.log(
  `\n[meter] cost=$${costUsd ?? "?"} USD | remaining=$${balanceUsd ?? "?"} USD | chatId=${chatId ?? "n/a"}`,
);

if (chatId) {
  const proof = await verifyChatProof({
    proxyBaseUrl: proxyUrl,
    chatId,
    model,
    requestBody,
    responseBody: rawResponseBody,
    upstreamRequestHash,
  });
  console.log(
    "[tee] verified:",
    proof.valid,
    `(${proof.signatureKind}, attestation=${proof.attestationMatched}, signer=${proof.recoveredAddress})`,
  );
}
