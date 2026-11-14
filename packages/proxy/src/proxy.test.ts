import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import {
  BalanceResponse,
  ChallengeResponseBody,
  NEAR_USDC_CONTRACT_MAINNET,
  RedeemResponse,
} from "@near402/protocol";
import { loadConfig } from "./config.js";
import { SessionLedger } from "./ledger.js";
import { createProxyServer } from "./server.js";

function listenServer(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Sipx near402 proxy: full 402 challenge, dual-rail verification, streaming metering & replay protection", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "near402-proxy-test-"));
  const ledgerPath = path.join(tmpDir, "ledger.json");

  let oneClickStatus: "PROCESSING" | "SUCCESS" = "PROCESSING";
  const sellerAccount = "seller.near";

  // 1. Mock NEAR AI Cloud upstream
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};

    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "Qwen/Qwen3-VL-30B-A3B-Instruct",
              pricing: { input: 0.15, output: 0.55 },
            },
          ],
        }),
      );
      return;
    }

    if (req.url?.startsWith("/v1/attestation/report")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signing_address: "0xabc123", attested: true }));
      return;
    }

    if (req.url?.startsWith("/v1/signature/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          signature: "0xsig",
          signing_address: "0xabc123",
          signature_kind: "provider_tee",
        }),
      );
      return;
    }

    if (req.url === "/v1/chat/completions") {
      assert.equal(req.headers.authorization, "Bearer test-near-ai-key");
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chat_stream_1",
            choices: [{ delta: { content: "Hello " } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chat_stream_1",
            choices: [{ delta: { content: "NEAR!" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chat_stream_1",
            choices: [],
            usage: { prompt_tokens: 1000, completion_tokens: 2000 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chat_nonstream_1",
          choices: [{ message: { role: "assistant", content: "Private TEE hello!" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 1000 },
        }),
      );
      return;
    }

    res.writeHead(404).end();
  });

  // 2. Mock NEAR JSON-RPC
  const rpcServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const rpcReq = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      params?: { tx_hash?: string };
    };
    const txHash = rpcReq.params?.tx_hash;

    res.writeHead(200, { "Content-Type": "application/json" });

    if (txHash === "tx_usdc_ok") {
      const args = Buffer.from(
        JSON.stringify({ receiver_id: sellerAccount, amount: "100000" }),
      ).toString("base64"); // 0.10 USDC
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            status: { SuccessValue: "" },
            transaction: {
              signer_id: "agent.near",
              receiver_id: NEAR_USDC_CONTRACT_MAINNET,
              actions: [
                {
                  FunctionCall: {
                    method_name: "ft_transfer",
                    args,
                    deposit: "1",
                  },
                },
              ],
            },
            receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
          },
        }),
      );
      return;
    }

    if (txHash === "tx_near_small") {
      // 0.001 NEAR @ $3.50 = $0.0035
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            status: { SuccessValue: "" },
            transaction: {
              signer_id: "agent.near",
              receiver_id: sellerAccount,
              actions: [{ Transfer: { deposit: "1000000000000000000000" } }],
            },
            receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
          },
        }),
      );
      return;
    }

    if (txHash === "tx_wrong_recipient") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            status: { SuccessValue: "" },
            transaction: {
              signer_id: "agent.near",
              receiver_id: "attacker.near",
              actions: [{ Transfer: { deposit: "100000000000000000000000" } }],
            },
            receipts_outcome: [],
          },
        }),
      );
      return;
    }

    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        error: { message: "UNKNOWN_TRANSACTION" },
      }),
    );
  });

  // 3. Mock 1Click Intents server
  const intentsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/v0/tokens") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            assetId: `nep141:${NEAR_USDC_CONTRACT_MAINNET}`,
            decimals: 6,
            blockchain: "near",
            symbol: "USDC",
            price: 1.0,
            contractAddress: NEAR_USDC_CONTRACT_MAINNET,
          },
          {
            assetId: "nep141:wrap.near",
            decimals: 24,
            blockchain: "near",
            symbol: "wNEAR",
            price: 3.5,
            contractAddress: "wrap.near",
          },
          {
            assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
            decimals: 6,
            blockchain: "base",
            symbol: "USDC",
            price: 1.0,
            contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          },
        ]),
      );
      return;
    }

    if (url.pathname === "/v0/quote" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          quote: {
            depositAddress: "0x1click_deposit_addr",
            amountIn: "100000",
            amountInFormatted: "0.10",
            amountOut: "99500",
            amountOutFormatted: "0.0995",
            minAmountOut: "98500",
            deadline: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      );
      return;
    }

    if (url.pathname === "/v0/deposit/submit") {
      res.writeHead(200).end("{}");
      return;
    }

    if (url.pathname === "/v0/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: oneClickStatus,
          quoteResponse: {
            quoteRequest: {
              recipient: sellerAccount,
              destinationAsset: `nep141:${NEAR_USDC_CONTRACT_MAINNET}`,
            },
          },
          swapDetails: { amountOut: "99500" },
        }),
      );
      return;
    }

    res.writeHead(404).end();
  });

  const [upstreamUrl, rpcUrl, oneClickUrl] = await Promise.all([
    listenServer(upstreamServer),
    listenServer(rpcServer),
    listenServer(intentsServer),
  ]);

  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    NEAR_AI_API_KEY: "test-near-ai-key",
    SELLER_ACCOUNT_ID: sellerAccount,
    NEAR_NETWORK: "mainnet",
    NEAR_RPC_URL: rpcUrl,
    UPSTREAM_BASE_URL: `${upstreamUrl}/v1`,
    ONECLICK_BASE_URL: oneClickUrl,
    SESSION_SECRET: "test-secret-key-for-hmac",
    MARKUP_BPS: "1000", // 10% markup
    LEDGER_PATH: ledgerPath,
  });

  const { server } = createProxyServer({ config });
  const proxyUrl = await listenServer(server);

  try {
    // 1. Unpaid request -> 402 Payment Required
    const unpaid = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(unpaid.status, 402);
    assert.ok(unpaid.headers.get("www-authenticate")?.startsWith("NEAR402 "));
    const challengeBody = (await unpaid.json()) as ChallengeResponseBody;
    assert.equal(challengeBody.challenge.rails.nearDirect.recipient, sellerAccount);
    assert.equal(challengeBody.challenge.pricing.inputUsdPer1M, 0.165); // 0.15 + 10%
    assert.equal(challengeBody.challenge.pricing.outputUsdPer1M, 0.605); // 0.55 + 10%

    // 2. Wrong recipient rejected
    const badRedeem = await fetch(`${proxyUrl}/v1/402/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rail: "near_direct",
        txHash: "tx_wrong_recipient",
        senderAccountId: "agent.near",
      }),
    });
    assert.equal(badRedeem.status, 400);

    // 3. Valid USDC ft_transfer redeemed -> $0.10 session token
    const goodRedeem = await fetch(`${proxyUrl}/v1/402/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rail: "near_direct",
        txHash: "tx_usdc_ok",
        senderAccountId: "agent.near",
      }),
    });
    assert.equal(goodRedeem.status, 200);
    const redeemed = (await goodRedeem.json()) as RedeemResponse;
    assert.equal(redeemed.creditedUsd, 0.1);
    assert.equal(redeemed.balanceUsd, 0.1);
    assert.ok(redeemed.token.startsWith("near402_"));

    // 4. Replay protection rejects duplicate txHash
    const replay = await fetch(`${proxyUrl}/v1/402/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rail: "near_direct",
        txHash: "tx_usdc_ok",
        senderAccountId: "agent.near",
      }),
    });
    assert.equal(replay.status, 400);

    // 5. Tampered token rejected with 402
    const tampered = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${redeemed.token}tamper`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(tampered.status, 402);

    // 6. Non-streaming chat completion -> metered exact token cost
    // 1000 input * 0.165/1M + 1000 output * 0.605/1M = 0.00077
    const chatRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${redeemed.token}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.headers.get("x-near-chat-id"), "chat_nonstream_1");
    assert.equal(Number(chatRes.headers.get("x-near402-cost-usd")), 0.00077);

    // 7. Streaming chat completion -> streams SSE + meters usage
    // 1000 input * 0.165/1M + 2000 output * 0.605/1M = 0.001375
    const streamRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${redeemed.token}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        stream: true,
        messages: [{ role: "user", content: "Stream test" }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const sseText = await streamRes.text();
    assert.ok(sseText.includes("Hello "));
    assert.ok(sseText.includes("NEAR!"));

    // Check updated balance: 0.10 - 0.00077 - 0.001375 = 0.097855
    const balRes = await fetch(`${proxyUrl}/v1/402/balance`, {
      headers: { Authorization: `Bearer ${redeemed.token}` },
    });
    assert.equal(balRes.status, 200);
    const bal = (await balRes.json()) as BalanceResponse;
    assert.equal(bal.requestsCount, 2);
    assert.equal(bal.balanceUsd, 0.097855);

    // 8. 1Click Intents quote + pending (202) -> settled (200)
    const quoteRes = await fetch(`${proxyUrl}/v1/402/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        refundTo: "0x1111111111111111111111111111111111111111",
        amountUsd: 0.1,
      }),
    });
    assert.equal(quoteRes.status, 200);
    const quoteJson = (await quoteRes.json()) as {
      quote: { depositAddress: string };
    };
    assert.equal(quoteJson.quote.depositAddress, "0x1click_deposit_addr");

    const pendingRedeem = await fetch(`${proxyUrl}/v1/402/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rail: "near_intents",
        depositAddress: "0x1click_deposit_addr",
      }),
    });
    assert.equal(pendingRedeem.status, 202);

    oneClickStatus = "SUCCESS";
    const settledRedeem = await fetch(`${proxyUrl}/v1/402/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rail: "near_intents",
        depositAddress: "0x1click_deposit_addr",
        token: redeemed.token,
      }),
    });
    assert.equal(settledRedeem.status, 200);
    const toppedUp = (await settledRedeem.json()) as RedeemResponse;
    assert.equal(toppedUp.creditedUsd, 0.0995);
    assert.equal(toppedUp.balanceUsd, 0.197355);

    // 9. Single-shot X-402-Payment header with native NEAR transfer
    const singleShot = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-402-Payment": "near_direct:tx_near_small:agent.near",
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        messages: [{ role: "user", content: "Single shot!" }],
      }),
    });
    assert.equal(singleShot.status, 200);

    // 10. TEE verification pass-through
    const attRes = await fetch(
      `${proxyUrl}/v1/attestation/report?model=Qwen/Qwen3-VL-30B-A3B-Instruct`,
    );
    assert.equal(attRes.status, 200);
    const sigRes = await fetch(`${proxyUrl}/v1/signature/chat_nonstream_1`);
    assert.equal(sigRes.status, 200);

    // 11. Ledger persistence across restart
    const reloadedLedger = new SessionLedger("test-secret-key-for-hmac", ledgerPath);
    const verified = reloadedLedger.verifyToken(redeemed.token);
    assert.ok(verified);
    assert.equal(verified.balanceUsd, 0.197355);
    assert.equal(reloadedLedger.isTxRedeemed("near:tx_usdc_ok"), true);

    // 12. Playground UI served at /playground
    const playgroundRes = await fetch(`${proxyUrl}/playground`);
    assert.equal(playgroundRes.status, 200);
    assert.match(playgroundRes.headers.get("content-type") || "", /text\/html/);
    const html = await playgroundRes.text();
    assert.ok(html.includes("@hot-labs/near-connect"));
    assert.ok(html.includes("NearConnector"));
    assert.ok(html.includes("claimTrialBtn"));
  } finally {
    await Promise.all([
      closeServer(server),
      closeServer(upstreamServer),
      closeServer(rpcServer),
      closeServer(intentsServer),
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Sipx near402 proxy: max_tokens clamping, reservation refund on upstream failure & /v1/402/trial", async () => {
  let observedMaxTokens = 0;
  let failUpstream = false;

  const upstreamServer = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      max_tokens?: number;
    };
    observedMaxTokens = Number(body.max_tokens || 0);

    if (failUpstream) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_down" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chat_clamp_1",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    );
  });

  const upstreamUrl = await listenServer(upstreamServer);
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    NEAR_AI_API_KEY: "test-key",
    SELLER_ACCOUNT_ID: "seller.near",
    UPSTREAM_BASE_URL: `${upstreamUrl}/v1`,
    ONECLICK_BASE_URL: "http://127.0.0.1:9",
    FREE_ALLOWANCE_USD: "0.001", // $0.001 trial
    MAX_OUTPUT_TOKENS_CAP: "8192",
    MARKUP_BPS: "0",
    LEDGER_PATH: "",
  });

  const { server } = createProxyServer({ config });
  const proxyUrl = await listenServer(server);

  try {
    // 1. /health advertises freeAllowanceUsd
    const health = (await (await fetch(`${proxyUrl}/health`)).json()) as {
      freeAllowanceUsd: number;
    };
    assert.equal(health.freeAllowanceUsd, 0.001);

    // 2. Claim trial once -> $0.001 token; second claim from same IP -> 429
    const trialRes = await fetch(`${proxyUrl}/v1/402/trial`, { method: "POST" });
    assert.equal(trialRes.status, 200);
    const trial = (await trialRes.json()) as { token: string; balanceUsd: number };
    assert.equal(trial.balanceUsd, 0.001);

    const dupTrial = await fetch(`${proxyUrl}/v1/402/trial`, { method: "POST" });
    assert.equal(dupTrial.status, 429);

    // 3. Upstream failure refunds full reservation
    failUpstream = true;
    const failedCall = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${trial.token}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        max_tokens: 50000,
        messages: [{ role: "user", content: "fail test" }],
      }),
    });
    assert.equal(failedCall.status, 500);
    const balAfterFail = (await (
      await fetch(`${proxyUrl}/v1/402/balance`, {
        headers: { Authorization: `Bearer ${trial.token}` },
      })
    ).json()) as BalanceResponse;
    assert.equal(balAfterFail.balanceUsd, 0.001);
    assert.equal(balAfterFail.requestsCount, 0);

    // 4. Huge max_tokens gets clamped to affordable output tokens (~1815 tokens for $0.001 @ $0.55/1M)
    failUpstream = false;
    const okCall = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${trial.token}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        max_tokens: 50000,
        messages: [{ role: "user", content: "clamp test" }],
      }),
    });
    assert.equal(okCall.status, 200);
    assert.ok(observedMaxTokens > 100 && observedMaxTokens < 2000);
  } finally {
    await Promise.all([closeServer(server), closeServer(upstreamServer)]);
  }
});

