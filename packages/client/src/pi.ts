import { DEFAULT_MODEL_ID } from "@near402/protocol";
import { claimTrialToken, createNear402Fetch } from "./fetch.js";
import { SpendGuardrail, SpendPolicy } from "./guardrails.js";
import { verifyChatProof } from "./tee.js";
import {
  loadOrCreateWallet,
  loadSessionTokens,
  resolveProxyUrl,
  saveSessionToken,
} from "./wallet.js";

export interface PiCommandContext {
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
  sendMessage?: (text: string) => void;
}

export interface PiExtensionAPI {
  registerCommand: (
    name: string,
    spec: {
      description: string;
      handler: (args: string, ctx?: PiCommandContext) => Promise<void | string> | void | string;
    },
  ) => void;
  registerTool?: (tool: {
    name: string;
    label?: string;
    description: string;
    parameters?: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: { prompt: string; model?: string; verifyTee?: boolean },
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }) => void;
}

export interface PiNear402Options {
  proxyUrl?: string;
  passphrase?: string;
  spendPolicy?: SpendPolicy;
  autoClaimTrial?: boolean;
  defaultModel?: string;
}

/**
 * Create Pi-compatible `/fund`, `/spend`, and `near402_chat` handlers backed by
 * `loadOrCreateWallet`, `createNear402Fetch`, `SpendGuardrail`, and `verifyChatProof`.
 */
export function createPiNear402Extension(options: PiNear402Options = {}) {
  const proxyUrl = resolveProxyUrl(options.proxyUrl);
  const spendPolicy: SpendPolicy = options.spendPolicy ?? {
    maxPerPaymentUsd: 0.25,
    maxHourlyUsd: 1.0,
    maxDailyUsd: 5.0,
  };

  function getReadyWallet() {
    const envId = process.env.NEAR_ACCOUNT_ID;
    const envKey = process.env.NEAR_PRIVATE_KEY as `ed25519:${string}` | undefined;
    if (envId && envKey) {
      return {
        accountId: envId,
        privateKey: envKey,
        network: "mainnet" as const,
        keyType: "full_access" as const,
      };
    }
    return loadOrCreateWallet({
      passphrase: options.passphrase ?? process.env.NEAR402_WALLET_PASSPHRASE,
    }).wallet;
  }

  async function handleFund(args = "", ctx?: PiCommandContext): Promise<string> {
    const wallet = getReadyWallet();
    const targetUrl = resolveProxyUrl(args.trim() || proxyUrl);
    const origin = new URL(targetUrl).origin;
    const sessions = loadSessionTokens();
    let msg = `Sipx / near402 agent account: ${wallet.accountId} (${wallet.network}, keyType=${wallet.keyType})`;

    if (!sessions[origin] && (options.autoClaimTrial ?? true)) {
      const trial = await claimTrialToken({ proxyBaseUrl: origin });
      if (trial) {
        saveSessionToken(origin, trial.token);
        msg += `\nClaimed free trial: $${trial.balanceUsd.toFixed(4)} USD ready on ${origin}`;
      }
    }
    msg += `\nFund NEAR + USDC (or bundle 0.02 NEAR gas starter): ${origin}/playground?fund=${wallet.accountId}`;
    ctx?.ui?.notify?.(msg, "info");
    return msg;
  }

  async function handleSpend(_args = "", ctx?: PiCommandContext): Promise<string> {
    const summary = new SpendGuardrail(spendPolicy).getSummary();
    const line = `Sipx spend: 1h=$${summary.hourlyUsd.toFixed(4)} | 24h=$${summary.dailyUsd.toFixed(4)} | total=$${summary.totalSpentUsd.toFixed(4)} USD`;
    ctx?.ui?.notify?.(line, "info");
    return line;
  }

  async function executeChatTool(
    _toolCallId: string,
    params: { prompt: string; model?: string; verifyTee?: boolean },
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const wallet = getReadyWallet();
    const model = params.model || options.defaultModel || DEFAULT_MODEL_ID;
    const fetch402 = createNear402Fetch({
      accountId: wallet.accountId,
      privateKey: wallet.privateKey,
      keyType: wallet.keyType,
      network: wallet.network,
      spendPolicy,
      autoClaimTrial: options.autoClaimTrial ?? true,
    });

    const requestBody = {
      model,
      stream: false,
      messages: [{ role: "user", content: params.prompt }],
    };
    const rawBody = JSON.stringify(requestBody);
    const res = await fetch402(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });
    const responseBody = await res.text();
    if (!res.ok) {
      throw new Error(`near402_chat failed (${res.status}): ${responseBody}`);
    }

    const parsed = JSON.parse(responseBody) as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    let text = parsed.choices?.[0]?.message?.content ?? responseBody;

    if (params.verifyTee && parsed.id) {
      const proof = await verifyChatProof({
        proxyBaseUrl: proxyUrl,
        chatId: parsed.id,
        model,
        requestBody: rawBody,
        responseBody,
      });
      text += `\n\n[TEE verified: ${proof.valid} | signingAddress: ${proof.signingAddress}]`;
    }

    return { content: [{ type: "text", text }] };
  }

  function register(pi: PiExtensionAPI) {
    pi.registerCommand("fund", {
      description: "Show Sipx (near402) agent wallet, claim starter trial, and print funding link",
      handler: handleFund,
    });
    pi.registerCommand("spend", {
      description: "Show local Sipx (near402) spend ledger totals",
      handler: handleSpend,
    });
    pi.registerTool?.({
      name: "near402_chat",
      label: "Sipx Private TEE Inference",
      description:
        "Run verifiable NEAR AI Cloud TEE inference via Sipx HTTP 402 micropayments with local SpendGuardrail caps.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          verifyTee: { type: "boolean" },
        },
        required: ["prompt"],
      },
      execute: executeChatTool,
    });
  }

  return { register, handleFund, handleSpend, executeChatTool };
}

export function registerPiNear402(pi: PiExtensionAPI, options?: PiNear402Options): void {
  createPiNear402Extension(options).register(pi);
}

export default function piExtension(pi: PiExtensionAPI): void {
  registerPiNear402(pi);
}
