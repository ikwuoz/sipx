#!/usr/bin/env node
import readline from "node:readline";
import { JsonRpcProvider, KeyPairString } from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import { USDC } from "near-api-js/tokens/mainnet";
import { DEFAULT_MODEL_ID, NEAR_USDC_CONTRACT_MAINNET, NearNetwork } from "@near402/protocol";
import { startLocalBridge } from "./bridge.js";
import { claimTrialToken, createNear402Fetch } from "./fetch.js";
import { SpendGuardrail, SpendPolicy } from "./guardrails.js";
import {
  inspectAgentKey,
  provisionAgentKey,
  ProvisionAgentKeyMode,
  revokeAgentKey,
} from "./keys.js";
import { MIN_GAS_RESERVE_YOCTO, PaymentRail, PreferredAsset } from "./payer.js";
import {
  createNearAccount,
  defaultClientConfigPath,
  defaultWalletPath,
  encryptExistingWallet,
  getDefaultRpcUrl,
  loadClientConfig,
  loadOrCreateWallet,
  loadSessionTokens,
  loadWallet,
  loadWalletMeta,
  resolveProxyUrl,
  saveClientConfig,
  saveSessionToken,
  WalletKeyType,
} from "./wallet.js";

function parseFlags(args: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function promptSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Passphrase required in non-interactive mode. Pass --passphrase or set NEAR402_WALLET_PASSPHRASE.`,
    );
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const stdin = process.stdin;
    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.removeListener("data", onData);
      }
    };
    stdin.on("data", onData);
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolvePassphrase(
  flags: Record<string, string | boolean>,
  required: boolean,
  promptText = "Wallet passphrase: ",
): Promise<string | undefined> {
  if (typeof flags.passphrase === "string" && flags.passphrase) {
    return flags.passphrase;
  }
  if (process.env.NEAR402_WALLET_PASSPHRASE) {
    return process.env.NEAR402_WALLET_PASSPHRASE;
  }
  if (!required) return undefined;
  return promptSecret(promptText);
}

async function resolveCliCredentials(flags: Record<string, string | boolean>): Promise<{
  accountId: string;
  privateKey: KeyPairString;
  network: NearNetwork;
  keyType: WalletKeyType;
  autoCreated: boolean;
}> {
  const envAccountId = process.env.NEAR_ACCOUNT_ID;
  const envPrivateKey = process.env.NEAR_PRIVATE_KEY as `ed25519:${string}` | undefined;
  const cfg = loadClientConfig();
  const network: NearNetwork =
    flags.network === "testnet" || cfg.network === "testnet" ? "testnet" : "mainnet";

  if (envAccountId && envPrivateKey) {
    return {
      accountId: envAccountId,
      privateKey: envPrivateKey,
      network,
      keyType: "full_access",
      autoCreated: false,
    };
  }

  const meta = loadWalletMeta();
  if (!meta) {
    const passphrase = await resolvePassphrase(
      flags,
      Boolean(flags.encrypt || flags.passphrase),
      "New wallet encryption passphrase: ",
    );
    const { wallet, created } = loadOrCreateWallet({ network, passphrase });
    if (created) {
      console.error(
        `[near402] Auto-created agent wallet ${wallet.accountId} at ${defaultWalletPath()}`,
      );
    }
    return {
      accountId: wallet.accountId,
      privateKey: wallet.privateKey,
      network: (flags.network as NearNetwork) || wallet.network,
      keyType: wallet.keyType,
      autoCreated: created,
    };
  }

  const passphrase = meta.encrypted
    ? await resolvePassphrase(flags, true, "Wallet passphrase: ")
    : undefined;
  const wallet = loadWallet({ passphrase });
  if (!wallet) {
    throw new Error(`Failed to load wallet at ${defaultWalletPath()}`);
  }
  return {
    accountId: wallet.accountId,
    privateKey: wallet.privateKey,
    network: (flags.network as NearNetwork) || wallet.network,
    keyType: wallet.keyType,
    autoCreated: false,
  };
}

function parseSpendPolicy(flags: Record<string, string | boolean>): SpendPolicy {
  return {
    maxPerPaymentUsd:
      typeof flags["max-per-payment"] === "string"
        ? Number(flags["max-per-payment"])
        : Number(process.env.NEAR402_MAX_PER_PAYMENT_USD || 1.0),
    maxHourlyUsd:
      typeof flags["max-hourly"] === "string"
        ? Number(flags["max-hourly"])
        : process.env.NEAR402_MAX_HOURLY_USD
          ? Number(process.env.NEAR402_MAX_HOURLY_USD)
          : undefined,
    maxDailyUsd:
      typeof flags["max-daily"] === "string"
        ? Number(flags["max-daily"])
        : Number(process.env.NEAR402_MAX_DAILY_USD || 5.0),
    allowedRecipients:
      typeof flags["allow-recipient"] === "string"
        ? flags["allow-recipient"].split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
  };
}

async function fetchChainBalances(accountId: string, network: NearNetwork): Promise<{
  activated: boolean;
  nearYocto: bigint;
  nearDecimal: string;
  usdcUnits: bigint;
  usdcDecimal: string;
  nearError?: string;
}> {
  const provider = new JsonRpcProvider({ url: getDefaultRpcUrl(network) });
  let activated = false;
  let nearYocto = 0n;
  let nearDecimal = "0";
  let nearError: string | undefined;

  try {
    const acct = await provider.viewAccount({ accountId });
    activated = true;
    nearYocto = BigInt(acct.amount);
    nearDecimal = NEAR.toDecimal(nearYocto, 6);
  } catch (err) {
    nearError = err instanceof Error ? err.message : String(err);
  }

  let usdcUnits = 0n;
  let usdcDecimal = "0.0000";
  if (network === "mainnet") {
    try {
      const raw = await provider.callFunction({
        contractId: NEAR_USDC_CONTRACT_MAINNET,
        method: "ft_balance_of",
        args: { account_id: accountId },
      });
      usdcUnits = typeof raw === "string" ? BigInt(raw) : 0n;
      usdcDecimal = USDC.toDecimal(usdcUnits, 4);
    } catch {
      // ignore
    }
  }

  return { activated, nearYocto, nearDecimal, usdcUnits, usdcDecimal, nearError };
}

async function cmdInit(flags: Record<string, string | boolean>) {
  const network: NearNetwork = flags.network === "testnet" ? "testnet" : "mainnet";
  const wantEncrypt = Boolean(flags.encrypt || flags.passphrase);
  const passphrase = await resolvePassphrase(
    flags,
    wantEncrypt,
    "New wallet encryption passphrase: ",
  );

  const { wallet, created } = loadOrCreateWallet({ network, passphrase });
  console.log(
    created
      ? `Created new NEAR agent wallet at ${defaultWalletPath()}`
      : `Loaded existing NEAR agent wallet at ${defaultWalletPath()}`,
  );
  console.log(`Network:    ${wallet.network}`);
  console.log(`Account ID: ${wallet.accountId}`);
  console.log(`Public Key: ${wallet.publicKey}`);
  console.log(`Key Type:   ${wallet.keyType}`);
  console.log(`Encrypted:  ${wallet.encrypted ? "AES-256-GCM (scrypt)" : "no"}`);
  console.log("");
  const proxyUrl = resolveProxyUrl(typeof flags.url === "string" ? flags.url : undefined);
  console.log("Next step: claim a free trial or fund this account once:");
  console.log("  - Free trial / funding guide: near402 fund");
  console.log(`  - Account / Address:          ${wallet.accountId}`);
  console.log(`  - Browser wallet funder:      ${proxyUrl}/playground?fund=${wallet.accountId}`);
  if (wallet.network === "testnet") {
    console.log("  - Testnet faucet:             https://near-faucet.io/");
  }
  console.log("Then run:");
  console.log('  near402 chat "Hello from an autonomous NEAR agent!"');
}

async function cmdUse(urlArg: string | undefined, flags: Record<string, string | boolean>) {
  const candidate = urlArg || (typeof flags.url === "string" ? flags.url : undefined);
  if (!candidate) {
    const cfg = loadClientConfig();
    console.log(`Config file: ${defaultClientConfigPath()}`);
    console.log(`Active URL:  ${resolveProxyUrl()}`);
    console.log(`Saved URL:   ${cfg.proxyUrl ?? "(not set; defaults to http://localhost:4020)"}`);
    return;
  }
  const normalized = new URL(candidate).origin;
  const network =
    flags.network === "testnet" || flags.network === "mainnet"
      ? (flags.network as NearNetwork)
      : undefined;
  const saved = saveClientConfig({ proxyUrl: normalized, ...(network ? { network } : {}) });
  console.log(`Saved active Sipx proxy (${defaultClientConfigPath()}): ${saved.proxyUrl}`);
}

async function cmdWallet(
  sub: string | undefined,
  flags: Record<string, string | boolean>,
) {
  if (sub !== "encrypt") {
    console.error("Usage: near402 wallet encrypt [--passphrase <pw>]");
    process.exit(1);
  }
  const meta = loadWalletMeta();
  if (!meta) {
    console.error(`No wallet found at ${defaultWalletPath()}. Run \`near402 init\` first.`);
    process.exit(1);
  }
  const currentPassphrase = meta.encrypted
    ? await resolvePassphrase(flags, true, "Current passphrase: ")
    : undefined;
  const newPassphrase =
    typeof flags["new-passphrase"] === "string"
      ? flags["new-passphrase"]
      : await resolvePassphrase(
          meta.encrypted ? {} : flags,
          true,
          "New encryption passphrase: ",
        );
  if (!newPassphrase) {
    throw new Error("Encryption passphrase cannot be empty");
  }
  const encrypted = encryptExistingWallet({
    currentPassphrase,
    newPassphrase,
  });
  console.log(`Encrypted wallet saved at ${defaultWalletPath()}`);
  console.log(`Account ID: ${encrypted.accountId}`);
  console.log(`Cipher:     ${encrypted.crypto.cipher} (KDF: ${encrypted.crypto.kdf})`);
}

async function cmdKey(
  sub: string | undefined,
  flags: Record<string, string | boolean>,
) {
  if (sub === "status") {
    const meta = loadWalletMeta();
    const accountId =
      (typeof flags.account === "string" && flags.account) || meta?.accountId;
    const publicKey =
      (typeof flags["public-key"] === "string" && flags["public-key"]) || meta?.publicKey;
    const network: NearNetwork =
      (flags.network as NearNetwork) || meta?.network || "mainnet";
    if (!accountId || !publicKey) {
      console.error("No wallet found. Run `near402 init` or pass --account and --public-key.");
      process.exit(1);
    }
    const status = await inspectAgentKey({ accountId, publicKey, network });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (sub === "provision") {
    const ownerId =
      (typeof flags.owner === "string" && flags.owner) || process.env.NEAR_ACCOUNT_ID;
    const ownerKey = (
      (typeof flags["owner-key"] === "string" && flags["owner-key"]) ||
      process.env.NEAR_PRIVATE_KEY
    ) as KeyPairString | undefined;
    if (!ownerId || !ownerKey) {
      console.error(
        "Usage: near402 key provision --owner <acct> --owner-key <ed25519:...> [--mode gas_key_full|gas_key_function_call|function_call] [--contract <id>] [--methods m1,m2] [--allowance 0.25] [--gas-deposit 0.05] [--nonces 4] [--save] [--encrypt]",
      );
      process.exit(1);
    }
    const network: NearNetwork = flags.network === "testnet" ? "testnet" : "mainnet";
    const mode = ((flags.mode as string) || "gas_key_full") as ProvisionAgentKeyMode;
    const ownerAccount = createNearAccount({
      accountId: ownerId,
      privateKey: ownerKey,
      network,
    });
    const wantEncrypt = Boolean(flags.encrypt || flags.passphrase);
    const passphrase = wantEncrypt
      ? await resolvePassphrase(flags, true, "Encryption passphrase for agent wallet: ")
      : undefined;

    const result = await provisionAgentKey({
      ownerAccount,
      network,
      mode,
      contractId: typeof flags.contract === "string" ? flags.contract : undefined,
      methodNames:
        typeof flags.methods === "string"
          ? flags.methods.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      allowanceNear: typeof flags.allowance === "string" ? flags.allowance : undefined,
      gasDepositNear:
        typeof flags["gas-deposit"] === "string" ? flags["gas-deposit"] : undefined,
      numNonces: typeof flags.nonces === "string" ? Number(flags.nonces) : undefined,
      saveToWallet: Boolean(flags.save),
      passphrase,
    });

    console.log(`Provisioned ${result.keyType} key on ${result.accountId} (${network}):`);
    console.log(`  Public Key: ${result.publicKey}`);
    if (result.walletPath) {
      console.log(
        `  Saved to:   ${result.walletPath} (${passphrase ? "AES-256-GCM encrypted" : "plaintext"})`,
      );
    } else {
      console.log(`  Private Key: ${result.privateKey}`);
    }
    console.log(`  Scope:      ${JSON.stringify(result.scope)}`);
    console.log(`  Tx Hash(es): ${result.txHashes.join(", ")}`);
    return;
  }

  if (sub === "revoke") {
    const ownerId =
      (typeof flags.owner === "string" && flags.owner) || process.env.NEAR_ACCOUNT_ID;
    const ownerKey = (
      (typeof flags["owner-key"] === "string" && flags["owner-key"]) ||
      process.env.NEAR_PRIVATE_KEY
    ) as KeyPairString | undefined;
    const publicKey =
      typeof flags["public-key"] === "string" ? flags["public-key"] : undefined;
    if (!ownerId || !ownerKey || !publicKey) {
      console.error(
        "Usage: near402 key revoke --owner <acct> --owner-key <ed25519:...> --public-key <ed25519:...>",
      );
      process.exit(1);
    }
    const network: NearNetwork = flags.network === "testnet" ? "testnet" : "mainnet";
    const ownerAccount = createNearAccount({
      accountId: ownerId,
      privateKey: ownerKey,
      network,
    });
    const txHash = await revokeAgentKey({ ownerAccount, publicKey });
    console.log(`Deleted key ${publicKey} from ${ownerId} (tx: ${txHash ?? "submitted"})`);
    return;
  }

  console.error("Usage: near402 key <status|provision|revoke>");
  process.exit(1);
}

async function cmdBalance(flags: Record<string, string | boolean>) {
  const meta = loadWalletMeta();
  if (!meta) {
    console.error("No wallet found. Run `near402 fund` or `near402 init` first.");
    process.exit(1);
  }
  const bal = await fetchChainBalances(meta.accountId, meta.network);

  console.log(
    `Wallet: ${meta.accountId} (${meta.network}, keyType=${meta.keyType}, encrypted=${meta.encrypted})`,
  );
  console.log(
    bal.activated
      ? `  NEAR: ${bal.nearDecimal} NEAR`
      : `  NEAR: 0 (unfunded implicit account: ${bal.nearError})`,
  );
  if (meta.network === "mainnet") {
    console.log(`  USDC: ${bal.usdcDecimal} USDC`);
  }
  if (
    meta.keyType !== "gas_key_full_access" &&
    meta.keyType !== "gas_key_function_call" &&
    bal.usdcUnits > 0n &&
    bal.nearYocto < MIN_GAS_RESERVE_YOCTO
  ) {
    const origin = new URL(
      resolveProxyUrl(typeof flags.url === "string" ? flags.url : undefined),
    ).origin;
    console.log(
      `  WARNING: Account holds ${bal.usdcDecimal} USDC but < 0.005 NEAR for tx gas! ` +
        `Top up >= 0.02 NEAR at ${origin}/playground?fund=${meta.accountId}&asset=NEAR`,
    );
  }

  const proxyUrl = resolveProxyUrl(
    typeof flags.url === "string" ? flags.url : undefined,
  );
  const sessions = loadSessionTokens();
  const origin = new URL(proxyUrl).origin;
  const token = sessions[origin];
  if (token) {
    try {
      const res = await fetch(`${origin}/v1/402/balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { balanceUsd: number; requestsCount: number };
        console.log(
          `Proxy session (${origin}): $${data.balanceUsd.toFixed(6)} USD (${data.requestsCount} requests)`,
        );
      }
    } catch {
      // Proxy may not be running
    }
  }

  const guardrail = new SpendGuardrail();
  const spend = guardrail.getSummary();
  console.log(
    `Spend ledger: 1h=$${spend.hourlyUsd.toFixed(4)} | 24h=$${spend.dailyUsd.toFixed(4)} | total=$${spend.totalSpentUsd.toFixed(4)} USD`,
  );
}

async function cmdFund(flags: Record<string, string | boolean>) {
  const cfg = loadClientConfig();
  const network: NearNetwork =
    flags.network === "testnet" || cfg.network === "testnet" ? "testnet" : "mainnet";
  const wantEncrypt = Boolean(flags.encrypt || flags.passphrase);
  const meta = loadWalletMeta();
  const passphrase =
    meta?.encrypted || wantEncrypt
      ? await resolvePassphrase(flags, true, "Wallet passphrase: ")
      : undefined;

  const { wallet, created } = loadOrCreateWallet({ network, passphrase });
  const proxyUrl = resolveProxyUrl(typeof flags.url === "string" ? flags.url : undefined);
  const origin = new URL(proxyUrl).origin;
  const bal = await fetchChainBalances(wallet.accountId, wallet.network);

  console.log(
    created
      ? `Created NEAR agent wallet: ${wallet.accountId}`
      : `Agent wallet: ${wallet.accountId}`,
  );
  console.log(`  Network:  ${wallet.network} (keyType=${wallet.keyType})`);
  console.log(
    bal.activated
      ? `  NEAR:     ${bal.nearDecimal} NEAR`
      : "  NEAR:     0 NEAR (unactivated implicit account — needs >= 0.02 NEAR to activate)",
  );
  if (wallet.network === "mainnet") {
    console.log(`  USDC:     ${bal.usdcDecimal} USDC`);
  }

  if (
    wallet.keyType !== "gas_key_full_access" &&
    wallet.keyType !== "gas_key_function_call" &&
    bal.usdcUnits > 0n &&
    bal.nearYocto < MIN_GAS_RESERVE_YOCTO
  ) {
    console.log("");
    console.log(
      `WARNING (USDC 0-gas trap): You hold ${bal.usdcDecimal} USDC but have insufficient NEAR to pay 1-yoctoNEAR + ft_transfer gas.`,
    );
    console.log(`  Fix: fund >= 0.02 NEAR once at ${origin}/playground?fund=${wallet.accountId}&asset=NEAR`);
  }

  const sessions = loadSessionTokens();
  const existingToken = sessions[origin];
  if (flags["no-trial"] !== true && (!existingToken || flags.trial === true)) {
    const trial = await claimTrialToken({ proxyBaseUrl: origin });
    if (trial) {
      saveSessionToken(origin, trial.token);
      console.log("");
      console.log(
        `Claimed starter free trial on ${origin}: $${trial.balanceUsd.toFixed(4)} USD credited!`,
      );
    }
  }

  console.log("");
  console.log("Funding options:");
  console.log(`  1. Browser wallet UI (auto-bundles 0.02 NEAR gas when sending USDC):`);
  console.log(`     ${origin}/playground?fund=${wallet.accountId}`);
  console.log(`  2. Direct transfer to agent NEAR address:`);
  console.log(`     ${wallet.accountId}`);
  console.log("  3. Run any OpenAI-compatible harness (pi, Codex, Cursor, Claude Code) via bridge:");
  console.log(`     near402 serve --url ${origin}`);
}

async function cmdServe(flags: Record<string, string | boolean>) {
  const creds = await resolveCliCredentials(flags);
  const proxyUrl = resolveProxyUrl(typeof flags.url === "string" ? flags.url : undefined);
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  const port = typeof flags.port === "string" ? Number(flags.port) : 4021;
  const spendPolicy = parseSpendPolicy(flags);
  const autoClaimTrial = flags["no-trial"] !== true;

  const started = await startLocalBridge({
    proxyBaseUrl: proxyUrl,
    host,
    port,
    accountId: creds.accountId,
    privateKey: creds.privateKey,
    keyType: creds.keyType,
    network: creds.network,
    spendPolicy,
    autoClaimTrial,
    onTrialClaimed: (trial) => {
      console.error(
        `[near402] Claimed starter free trial: $${trial.balanceUsd.toFixed(4)} USD`,
      );
    },
    onPayment: (receipt) => {
      console.error(
        `[near402] Paid $${receipt.creditedUsd.toFixed(4)} via ${receipt.rail} (tx: ${receipt.txRef})`,
      );
    },
  });

  console.log(`Sipx (near402) Local OpenAI Bridge listening at ${started.url}/v1`);
  console.log(`  Upstream proxy:  ${started.proxyOrigin}`);
  console.log(`  Agent wallet:    ${creds.accountId} (${creds.keyType})`);
  console.log(`  Auto-claim trial:${autoClaimTrial ? " enabled" : " disabled"}`);
  console.log(
    `  Spend caps:      per-tx=$${spendPolicy.maxPerPaymentUsd ?? "unlimited"} | daily=$${spendPolicy.maxDailyUsd ?? "unlimited"}`,
  );
  console.log("");
  console.log("Point any agent harness (pi, Codex, OpenAI SDK, Python) at:");
  console.log(`  OPENAI_BASE_URL=${started.url}/v1 OPENAI_API_KEY=near402`);
}

async function cmdSpend() {
  const guardrail = new SpendGuardrail();
  const summary = guardrail.getSummary();
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdChat(
  flags: Record<string, string | boolean>,
  positional: string[],
) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error('Usage: near402 chat [--url URL] [--model MODEL] "<prompt>"');
    process.exit(1);
  }

  const creds = await resolveCliCredentials(flags);
  const proxyUrl = resolveProxyUrl(
    typeof flags.url === "string" ? flags.url : undefined,
  );
  const model =
    (typeof flags.model === "string" && flags.model) || DEFAULT_MODEL_ID;
  const asset = ((flags.asset as string) || "auto") as PreferredAsset;
  const rail = ((flags.rail as string) || "near_direct") as PaymentRail;
  const stream = flags.stream !== "false";
  const spendPolicy = parseSpendPolicy(flags);
  const autoClaimTrial = flags["no-trial"] !== true;

  const fetch402 = createNear402Fetch({
    accountId: creds.accountId,
    privateKey: creds.privateKey,
    keyType: creds.keyType,
    network: creds.network,
    preferredAsset: asset,
    rail,
    spendPolicy,
    autoClaimTrial,
    onTrialClaimed: (trial) => {
      console.error(
        `[near402] Claimed starter free trial: $${trial.balanceUsd.toFixed(4)} USD`,
      );
    },
    onPayment: (receipt) => {
      console.error(
        `[near402] Paid $${receipt.creditedUsd.toFixed(4)} via ${receipt.rail} (tx: ${receipt.txRef})`,
      );
    },
  });

  const res = await fetch402(`${proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }

  if (!stream || !res.body) {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    console.log(json.choices?.[0]?.message?.content ?? JSON.stringify(json));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const text = chunk.choices?.[0]?.delta?.content;
            if (text) process.stdout.write(text);
          } catch {
            // ignore non-JSON SSE lines
          }
        }
      }
      nl = buf.indexOf("\n");
    }
  }
  process.stdout.write("\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "init": {
      const { flags } = parseFlags(rest);
      await cmdInit(flags);
      break;
    }
    case "use": {
      const { flags, positional } = parseFlags(rest);
      await cmdUse(positional[0], flags);
      break;
    }
    case "fund": {
      const { flags } = parseFlags(rest);
      await cmdFund(flags);
      break;
    }
    case "serve": {
      const { flags } = parseFlags(rest);
      await cmdServe(flags);
      break;
    }
    case "wallet": {
      const [sub, ...subRest] = rest;
      const { flags } = parseFlags(subRest);
      await cmdWallet(sub, flags);
      break;
    }
    case "key": {
      const [sub, ...subRest] = rest;
      const { flags } = parseFlags(subRest);
      await cmdKey(sub, flags);
      break;
    }
    case "balance": {
      const { flags } = parseFlags(rest);
      await cmdBalance(flags);
      break;
    }
    case "spend":
      await cmdSpend();
      break;
    case "chat": {
      const { flags, positional } = parseFlags(rest);
      await cmdChat(flags, positional);
      break;
    }
    default:
      console.log("near402 — Pay-per-token private AI inference CLI");
      console.log("");
      console.log("Quick Onboarding:");
      console.log("  near402 use <url>                     Save default Sipx proxy URL");
      console.log("  near402 fund [--url URL] [--trial]    Auto-init wallet, claim free trial, or check gas/funding");
      console.log("  near402 serve [--port 4021] [--url URL] Local OpenAI bridge for pi/Codex/Cursor/SDKs");
      console.log('  near402 chat [--url URL] "<prompt>"   Pay & stream private TEE inference');
      console.log("");
      console.log("Wallet, Gas Keys & Guardrails:");
      console.log("  near402 init [--network mainnet|testnet] [--encrypt] [--passphrase PW]");
      console.log("  near402 wallet encrypt [--passphrase PW]");
      console.log("  near402 key provision --owner ACCT --owner-key KEY [--mode gas_key_full|gas_key_function_call|function_call]");
      console.log("  near402 key status | near402 key revoke --owner ACCT --owner-key KEY --public-key PK");
      console.log("  near402 balance [--url URL]");
      console.log("  near402 spend");
      break;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
