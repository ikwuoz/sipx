import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Account } from "near-api-js";
import {
  createNear402Fetch,
  createPiNear402Extension,
  encryptExistingWallet,
  InsufficientGasError,
  loadClientConfig,
  loadOrCreateWallet,
  loadWallet,
  loadWalletMeta,
  NEAR_USDC_CONTRACT_MAINNET,
  provisionAgentKey,
  resolveProxyUrl,
  revokeAgentKey,
  saveClientConfig,
  sha256Hex,
  SpendGuardrail,
  SpendGuardrailError,
  startLocalBridge,
  verifyChatProof,
  type PiExtensionAPI,
} from "../dist/index.js";
import { loadConfig } from "../../proxy/dist/config.js";
import { createProxyServer } from "../../proxy/dist/server.js";

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

function signEip191(text: string, secretKey: Uint8Array): { address: string; signature: string } {
  const pub = secp256k1.getPublicKey(secretKey, false);
  const address = `0x${bytesToHex(keccak_256(pub.subarray(1)).subarray(-20))}`;
  const msgBytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const combined = new Uint8Array(prefix.length + msgBytes.length);
  combined.set(prefix, 0);
  combined.set(msgBytes, prefix.length);
  const digest = keccak_256(combined);
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, format: "recovered" });
  const ethSig = new Uint8Array(65);
  ethSig.set(rec.subarray(1), 0);
  ethSig[64] = rec[0] + 27;
  return { address, signature: `0x${bytesToHex(ethSig)}` };
}

test("near402 client createNear402Fetch auto-pays 402 once and caches session for subsequent calls", async () => {
  const sellerAccount = "seller.near";
  let transfersSent = 0;

  // Mock upstream
  const upstreamServer = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chat_client_test",
        choices: [{ message: { role: "assistant", content: "Paid & verified!" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });

  // Mock NEAR RPC
  const rpcServer = http.createServer(async (_req, res) => {
    const args = Buffer.from(
      JSON.stringify({ receiver_id: sellerAccount, amount: "100000" }),
    ).toString("base64");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: {
          status: { SuccessValue: "" },
          transaction: {
            signer_id: "buyer-agent.near",
            receiver_id: NEAR_USDC_CONTRACT_MAINNET,
            actions: [{ FunctionCall: { method_name: "ft_transfer", args, deposit: "1" } }],
          },
          receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
        },
      }),
    );
  });

  const [upstreamUrl, rpcUrl] = await Promise.all([
    listenServer(upstreamServer),
    listenServer(rpcServer),
  ]);

  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    NEAR_AI_API_KEY: "test-key",
    SELLER_ACCOUNT_ID: sellerAccount,
    NEAR_RPC_URL: rpcUrl,
    UPSTREAM_BASE_URL: `${upstreamUrl}/v1`,
    ONECLICK_BASE_URL: "http://127.0.0.1:9", // triggers fallback price cleanly
    LEDGER_PATH: "",
  });

  const { server } = createProxyServer({ config });
  const proxyUrl = await listenServer(server);

  const mockAccount = {
    accountId: "buyer-agent.near",
    async getBalance() {
      return 1_000_000n; // 1.00 USDC
    },
    async transfer() {
      transfersSent += 1;
      return {
        transaction: { hash: `tx_auto_${transfersSent}` },
        transaction_outcome: { id: `tx_auto_${transfersSent}` },
      };
    },
  } as unknown as Account;

  const payments: number[] = [];
  const fetch402 = createNear402Fetch({
    account: mockAccount,
    preferredAsset: "USDC",
    persistSessions: false,
    onPayment: (receipt) => payments.push(receipt.creditedUsd),
  });

  try {
    const [r1, r2] = await Promise.all([
      fetch402(`${proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
          messages: [{ role: "user", content: "One" }],
        }),
      }),
      fetch402(`${proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
          messages: [{ role: "user", content: "Two" }],
        }),
      }),
    ]);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(transfersSent, 1);
    assert.equal(payments.length, 1);

    const r3 = await fetch402(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        messages: [{ role: "user", content: "Three" }],
      }),
    });
    assert.equal(r3.status, 200);
    assert.equal(transfersSent, 1);
  } finally {
    await Promise.all([
      closeServer(server),
      closeServer(upstreamServer),
      closeServer(rpcServer),
    ]);
  }
});

test("verifyChatProof verifies EIP-191 TEE signatures and rejects tampered payloads or attestation mismatches", async () => {
  const { secretKey } = secp256k1.keygen();
  const model = "Qwen/Qwen3-VL-30B-A3B-Instruct";
  const requestBody = JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
  const responseBody = JSON.stringify({ id: "chat_tee_1", choices: [] });

  const signedText = `${model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  const { address, signature } = signEip191(signedText, secretKey);

  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url?.startsWith("/v1/signature/")) {
      res.end(
        JSON.stringify({
          text: signedText,
          signature,
          signing_address: address,
          signing_algo: "ecdsa",
          signature_kind: "provider_tee",
        }),
      );
      return;
    }
    if (req.url?.startsWith("/v1/attestation/report")) {
      res.end(JSON.stringify({ signing_address: address }));
      return;
    }
    res.writeHead(404).end();
  });

  const baseUrl = await listenServer(mockServer);
  try {
    const validProof = await verifyChatProof({
      proxyBaseUrl: baseUrl,
      chatId: "chat_tee_1",
      model,
      requestBody,
      responseBody,
    });
    assert.equal(validProof.valid, true);
    assert.equal(validProof.signatureValid, true);
    assert.equal(validProof.payloadMatched, true);
    assert.equal(validProof.attestationMatched, true);
    assert.equal(validProof.recoveredAddress.toLowerCase(), address.toLowerCase());

    const tampered = await verifyChatProof({
      proxyBaseUrl: baseUrl,
      chatId: "chat_tee_1",
      model,
      requestBody,
      responseBody: responseBody + "tamper",
    });
    assert.equal(tampered.valid, false);
    assert.equal(tampered.payloadMatched, false);

    const wrongAttestation = await verifyChatProof({
      proxyBaseUrl: baseUrl,
      chatId: "chat_tee_1",
      model,
      requestBody,
      responseBody,
      expectedSigningAddress: "0x0000000000000000000000000000000000000001",
    });
    assert.equal(wrongAttestation.valid, false);
    assert.equal(wrongAttestation.attestationMatched, false);
  } finally {
    await closeServer(mockServer);
  }
});

test("Encrypted wallet storage encrypts/decrypts via AES-256-GCM + scrypt and separates public metadata", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "near402-wallet-"));
  const walletPath = path.join(tmpDir, "wallet.json");
  try {
    const { wallet, created } = loadOrCreateWallet({
      walletPath,
      network: "mainnet",
      passphrase: "correct horse battery staple",
    });
    assert.equal(created, true);
    assert.equal(wallet.encrypted, true);

    const rawOnDisk = fs.readFileSync(walletPath, "utf8");
    assert.equal(rawOnDisk.includes(wallet.privateKey), false);
    assert.equal(rawOnDisk.includes('"aes-256-gcm"'), true);

    // Public metadata works without passphrase
    const meta = loadWalletMeta(walletPath);
    assert.equal(meta?.accountId, wallet.accountId);
    assert.equal(meta?.encrypted, true);

    // Wrong or missing passphrase fails
    assert.throws(() => loadWallet({ walletPath }), /encrypted/i);
    assert.throws(
      () => loadWallet({ walletPath, passphrase: "wrong passphrase" }),
      /Invalid wallet passphrase/i,
    );

    const decrypted = loadWallet({
      walletPath,
      passphrase: "correct horse battery staple",
    });
    assert.equal(decrypted?.privateKey, wallet.privateKey);

    // Also test upgrading a plaintext wallet in-place
    const plainPath = path.join(tmpDir, "plain-wallet.json");
    const plain = loadOrCreateWallet({ walletPath: plainPath, network: "mainnet" });
    assert.equal(plain.wallet.encrypted, false);
    encryptExistingWallet({ walletPath: plainPath, newPassphrase: "rotated-secret" });
    assert.equal(fs.readFileSync(plainPath, "utf8").includes(plain.wallet.privateKey), false);
    const reloaded = loadWallet({ walletPath: plainPath, passphrase: "rotated-secret" });
    assert.equal(reloaded?.privateKey, plain.wallet.privateKey);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("SpendGuardrail & createNear402Fetch enforce per-payment, rolling hourly/daily, and recipient caps before signing tx", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "near402-guard-"));
  const ledgerPath = path.join(tmpDir, "spend.json");
  const guard = new SpendGuardrail({
    maxPerPaymentUsd: 0.25,
    maxHourlyUsd: 0.4,
    maxDailyUsd: 0.5,
    allowedRecipients: ["seller.near"],
    ledgerPath,
  });

  try {
    assert.throws(
      () =>
        guard.assertAllowed({
          origin: "http://127.0.0.1:4020",
          recipientAccountId: "attacker.near",
          amountUsd: 0.1,
        }),
      (err: unknown) =>
        err instanceof SpendGuardrailError && err.code === "recipient_not_allowed",
    );

    assert.throws(
      () =>
        guard.assertAllowed({
          origin: "http://127.0.0.1:4020",
          recipientAccountId: "seller.near",
          amountUsd: 0.3,
        }),
      (err: unknown) =>
        err instanceof SpendGuardrailError && err.code === "per_payment_limit",
    );

    guard.recordSpend({
      origin: "http://127.0.0.1:4020",
      recipientAccountId: "seller.near",
      amountUsd: 0.25,
    });
    assert.throws(
      () =>
        guard.assertAllowed({
          origin: "http://127.0.0.1:4020",
          recipientAccountId: "seller.near",
          amountUsd: 0.2,
        }),
      (err: unknown) =>
        err instanceof SpendGuardrailError && err.code === "hourly_limit",
    );

    // Also verify createNear402Fetch blocks before calling account.transfer
    let transferCalled = false;
    const challengeServer = http.createServer((_req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "payment_required", message: "pay" },
          challenge: {
            protocol: "near402/v1",
            challengeId: "ch_guard",
            model: "m",
            pricing: { inputUsdPer1M: 0.1, outputUsdPer1M: 0.1, currency: "USD" },
            minTopUpUsd: "0.01",
            suggestedTopUpUsd: "0.50",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            redeemUrl: "/v1/402/redeem",
            rails: {
              nearDirect: {
                network: "mainnet",
                recipient: "seller.near",
                acceptedAssets: [
                  {
                    symbol: "NEAR",
                    decimals: 24,
                    suggestedAmount: "100000000000000000000000",
                    minAmount: "1000000000000000000000",
                  },
                ],
              },
              nearIntents: { quoteUrl: "/v1/402/quote", destinationAsset: "nep141:usdc" },
            },
          },
        }),
      );
    });
    const url = await listenServer(challengeServer);
    try {
      const fakeAccount = {
        accountId: "agent.near",
        transfer: async () => {
          transferCalled = true;
          return {};
        },
      } as unknown as Account;

      const fetch402 = createNear402Fetch({
        account: fakeAccount,
        persistSessions: false,
        spendPolicy: { maxPerPaymentUsd: 0.1 },
      });

      await assert.rejects(
        () => fetch402(`${url}/v1/chat/completions`, { method: "POST" }),
        (err: unknown) =>
          err instanceof SpendGuardrailError && err.code === "per_payment_limit",
      );
      assert.equal(transferCalled, false);
    } finally {
      await closeServer(challengeServer);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("provisionAgentKey supports gas_key_full, gas_key_function_call & function_call and saves encrypted wallet metadata", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "near402-keys-"));
  const walletPath = path.join(tmpDir, "scoped-wallet.json");
  const calls: Array<{ method: string; args: unknown }> = [];

  const mockOwner = {
    accountId: "treasury.near",
    addFullAccessGasKey: async (publicKey: string, numNonces?: number) => {
      calls.push({ method: "addFullAccessGasKey", args: { publicKey, numNonces } });
      return { transaction: { hash: "tx_add_gas_full" } };
    },
    addFunctionCallGasKey: async (args: unknown) => {
      calls.push({ method: "addFunctionCallGasKey", args });
      return { transaction: { hash: "tx_add_gas_fc" } };
    },
    addFunctionCallAccessKey: async (args: unknown) => {
      calls.push({ method: "addFunctionCallAccessKey", args });
      return { transaction: { hash: "tx_add_fc" } };
    },
    transferToGasKey: async (accountId: string, publicKey: string, amount: bigint) => {
      calls.push({ method: "transferToGasKey", args: { accountId, publicKey, amount } });
      return { transaction: { hash: "tx_fund_gas" } };
    },
    deleteKey: async (publicKey: string) => {
      calls.push({ method: "deleteKey", args: { publicKey } });
      return { transaction: { hash: "tx_delete" } };
    },
  } as unknown as Account;

  try {
    const res1 = await provisionAgentKey({
      ownerAccount: mockOwner,
      mode: "gas_key_full",
      numNonces: 4,
      gasDepositNear: "0.05",
      saveToWallet: true,
      walletPath,
      passphrase: "agent-key-passphrase",
    });
    assert.equal(res1.keyType, "gas_key_full_access");
    assert.deepEqual(res1.txHashes, ["tx_add_gas_full", "tx_fund_gas"]);

    const loaded = loadWallet({ walletPath, passphrase: "agent-key-passphrase" });
    assert.equal(loaded?.accountId, "treasury.near");
    assert.equal(loaded?.keyType, "gas_key_full_access");
    assert.equal(loaded?.scope?.numNonces, 4);

    const res2 = await provisionAgentKey({
      ownerAccount: mockOwner,
      mode: "gas_key_function_call",
      contractId: NEAR_USDC_CONTRACT_MAINNET,
      methodNames: ["ft_transfer"],
      gasDepositNear: "0",
    });
    assert.equal(res2.keyType, "gas_key_function_call");
    assert.equal(res2.scope.contractId, NEAR_USDC_CONTRACT_MAINNET);

    const res3 = await provisionAgentKey({
      ownerAccount: mockOwner,
      mode: "function_call",
      contractId: "vault.near",
      methodNames: ["spend"],
      allowanceNear: "0.25",
    });
    assert.equal(res3.keyType, "function_call");

    const delHash = await revokeAgentKey({
      ownerAccount: mockOwner,
      publicKey: res3.publicKey,
    });
    assert.equal(delHash, "tx_delete");
    assert.equal(calls.some((c) => c.method === "addFunctionCallGasKey"), true);
    assert.equal(calls.some((c) => c.method === "addFunctionCallAccessKey"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("verifyChatProof verifies NEAR AI Cloud gateway_attestation & model_attestations schemas + upstreamRequestHash", async () => {
  const gwKey = secp256k1.keygen().secretKey;
  const modelKey = secp256k1.keygen().secretKey;
  const model = "Qwen/Qwen3-VL-30B-A3B-Instruct";

  const clientReq = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] });
  const clampedReq = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 1024 });
  const streamRes = "data: {\"id\":\"chat_gw_1\"}\n\ndata: [DONE]\n\n";

  const gwText = `${sha256Hex(clampedReq)}:${sha256Hex(streamRes)}`;
  const gwSigned = signEip191(gwText, gwKey);
  const modelSample = signEip191("placeholder", modelKey);

  let sigCalls = 0;
  const mockServer = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/signature/")) {
      sigCalls++;
      if (sigCalls === 1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Chat id not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: gwText,
          signature: gwSigned.signature,
          signing_address: gwSigned.address,
          signing_algo: "ecdsa",
          signature_kind: "gateway",
        }),
      );
      return;
    }
    if (req.url?.startsWith("/v1/attestation/report")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          gateway_attestation: { signing_address: gwSigned.address },
          model_attestations: [{ signing_address: modelSample.address }],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const baseUrl = await listenServer(mockServer);
  try {
    const proof = await verifyChatProof({
      proxyBaseUrl: baseUrl,
      chatId: "chat_gw_1",
      model,
      requestBody: clientReq,
      responseBody: streamRes,
      upstreamRequestHash: sha256Hex(clampedReq),
    });
    assert.equal(sigCalls, 2);
    assert.equal(proof.valid, true);
    assert.equal(proof.signatureKind, "gateway");
    assert.equal(proof.signatureValid, true);
    assert.equal(proof.payloadMatched, true);
    assert.equal(proof.payloadSource, "proxy_normalized");
    assert.equal(proof.attestationMatched, true);
    assert.equal(proof.attestedAddress?.toLowerCase(), gwSigned.address.toLowerCase());
  } finally {
    await closeServer(mockServer);
  }
});

test("USDC 0-gas trap protection raises InsufficientGasError before attempting ft_transfer", async () => {
  const upstreamServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  const upstreamUrl = await listenServer(upstreamServer);
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    NEAR_AI_API_KEY: "test-key",
    SELLER_ACCOUNT_ID: "seller.near",
    UPSTREAM_BASE_URL: `${upstreamUrl}/v1`,
    ONECLICK_BASE_URL: "http://127.0.0.1:9",
    LEDGER_PATH: "",
  });
  const { server } = createProxyServer({ config });
  const proxyUrl = await listenServer(server);

  let transferAttempted = false;
  const zeroGasUsdcAccount = {
    accountId: "a".repeat(64),
    async getState() {
      throw new Error(`account ${"a".repeat(64)} does not exist while viewing`);
    },
    async getBalance() {
      return 2_000_000n; // Holds 2.00 USDC, 0 NEAR on-chain
    },
    async transfer() {
      transferAttempted = true;
      return {};
    },
  } as unknown as Account;

  try {
    const fetch402 = createNear402Fetch({
      account: zeroGasUsdcAccount,
      preferredAsset: "auto",
      persistSessions: false,
    });
    await assert.rejects(
      () =>
        fetch402(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof InsufficientGasError);
        assert.match(err.message, /0\.02 NEAR/i);
        assert.match(err.fundUrl, /asset=NEAR/);
        return true;
      },
    );
    assert.equal(transferAttempted, false);
  } finally {
    await Promise.all([closeServer(server), closeServer(upstreamServer)]);
  }
});

test("startLocalBridge auto-claims free trial and serves any OpenAI harness transparently", async () => {
  const upstreamServer = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3-VL-30B-A3B-Instruct" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chat_bridge_trial",
        choices: [{ message: { role: "assistant", content: "Served via local OpenAI bridge!" } }],
        usage: { prompt_tokens: 12, completion_tokens: 10 },
      }),
    );
  });
  const upstreamUrl = await listenServer(upstreamServer);

  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    NEAR_AI_API_KEY: "test-key",
    SELLER_ACCOUNT_ID: "seller.near",
    FREE_ALLOWANCE_USD: "0.05",
    UPSTREAM_BASE_URL: `${upstreamUrl}/v1`,
    ONECLICK_BASE_URL: "http://127.0.0.1:9",
    LEDGER_PATH: "",
  });
  const { server: proxyServer } = createProxyServer({ config });
  const proxyUrl = await listenServer(proxyServer);

  let paidOnChain = 0;
  let trialUsd = 0;
  const unfundedMockAccount = {
    accountId: "b".repeat(64),
    async transfer() {
      paidOnChain += 1;
      return {};
    },
  } as unknown as Account;

  const bridge = await startLocalBridge({
    proxyBaseUrl: proxyUrl,
    port: 0,
    account: unfundedMockAccount,
    autoClaimTrial: true,
    persistSessions: false,
    onTrialClaimed: (t) => {
      trialUsd = t.balanceUsd;
    },
  });

  try {
    // Harness checks /v1/models
    const modelsRes = await fetch(`${bridge.url}/v1/models`);
    assert.equal(modelsRes.status, 200);

    // Harness sends standard OpenAI SDK placeholder Authorization: Bearer near402
    const chatRes = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer near402",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello from pi harness!" }],
      }),
    });
    assert.equal(chatRes.status, 200);
    const json = (await chatRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(json.choices[0].message.content, "Served via local OpenAI bridge!");
    assert.equal(trialUsd, 0.05);
    assert.equal(paidOnChain, 0);
  } finally {
    await bridge.close();
    await Promise.all([closeServer(proxyServer), closeServer(upstreamServer)]);
  }
});

test("ClientConfig persistence and Pi extension adapter register /fund, /spend, and near402_chat", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "near402-pi-test-"));
  const cfgPath = path.join(tmpDir, "config.json");
  saveClientConfig({ proxyUrl: "https://sipx.example.com/", network: "testnet" }, cfgPath);
  const loaded = loadClientConfig(cfgPath);
  assert.equal(loaded.proxyUrl, "https://sipx.example.com");
  assert.equal(resolveProxyUrl(undefined, cfgPath), "https://sipx.example.com");

  const commands: string[] = [];
  const tools: string[] = [];
  const fakePi: PiExtensionAPI = {
    registerCommand(name) {
      commands.push(name);
    },
    registerTool(tool) {
      tools.push(tool.name);
    },
  };
  const ext = createPiNear402Extension({ proxyUrl: "http://127.0.0.1:4020" });
  ext.register(fakePi);
  assert.deepEqual(commands, ["fund", "spend"]);
  assert.deepEqual(tools, ["near402_chat"]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
