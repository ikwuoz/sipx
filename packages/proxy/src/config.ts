import crypto from "node:crypto";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PRICING,
  ModelPricing,
  NEAR_USDC_ASSET_ID_MAINNET,
  NEAR_USDC_CONTRACT_MAINNET,
  NEAR_USDT_CONTRACT_MAINNET,
  NEAR_WNEAR_CONTRACT_MAINNET,
  NearNetwork,
} from "@near402/protocol";

export interface ProxyConfig {
  port: number;
  host: string;
  nearAiApiKey: string;
  sellerAccountId: string;
  nearNetwork: NearNetwork;
  nearRpcUrl: string;
  upstreamBaseUrl: string;
  defaultModel: string;
  sessionSecret: string;
  markupBps: number;
  minTopUpUsd: number;
  suggestedTopUpUsd: number;
  freeAllowanceUsd: number;
  maxOutputTokensCap: number;
  oneClickApiKey: string;
  oneClickBaseUrl: string;
  ledgerPath: string;
  usdcContractId: string;
  usdcAssetId: string;
  usdtContractId: string;
  wnearContractId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const nearNetwork: NearNetwork =
    env.NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";

  const defaultRpc =
    nearNetwork === "testnet"
      ? "https://test.rpc.fastnear.com"
      : "https://free.rpc.fastnear.com";

  return {
    port: Number(env.PORT || 4020),
    host: env.HOST || "0.0.0.0",
    nearAiApiKey: env.NEAR_AI_API_KEY || "",
    sellerAccountId: env.SELLER_ACCOUNT_ID || "seller.near",
    nearNetwork,
    nearRpcUrl: env.NEAR_RPC_URL || defaultRpc,
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || "https://cloud-api.near.ai/v1").replace(
      /\/+$/,
      "",
    ),
    defaultModel: env.DEFAULT_MODEL || DEFAULT_MODEL_ID,
    sessionSecret:
      env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    markupBps: Number(env.MARKUP_BPS ?? 1000), // default 10% seller markup
    minTopUpUsd: Number(env.MIN_TOPUP_USD ?? 0.01),
    suggestedTopUpUsd: Number(env.SUGGESTED_TOPUP_USD ?? 0.1),
    freeAllowanceUsd: Number(env.FREE_ALLOWANCE_USD ?? 0),
    maxOutputTokensCap: Number(env.MAX_OUTPUT_TOKENS_CAP ?? 8192),
    oneClickApiKey: env.ONECLICK_API_KEY || "",
    oneClickBaseUrl: (
      env.ONECLICK_BASE_URL || "https://1click.chaindefuser.com"
    ).replace(/\/+$/, ""),
    ledgerPath: env.LEDGER_PATH ?? "./data/ledger.json",
    usdcContractId: env.USDC_CONTRACT_ID || NEAR_USDC_CONTRACT_MAINNET,
    usdcAssetId: env.USDC_ASSET_ID || NEAR_USDC_ASSET_ID_MAINNET,
    usdtContractId: env.USDT_CONTRACT_ID || NEAR_USDT_CONTRACT_MAINNET,
    wnearContractId: env.WNEAR_CONTRACT_ID || NEAR_WNEAR_CONTRACT_MAINNET,
  };
}

export class PricingCatalog {
  private readonly cache = new Map<string, ModelPricing>();
  private lastRefreshedAt = 0;

  constructor(
    private readonly upstreamBaseUrl: string,
    private readonly markupBps: number,
  ) {
    for (const [id, pricing] of Object.entries(DEFAULT_MODEL_PRICING)) {
      this.cache.set(id, this.withMarkup(pricing));
    }
  }

  private withMarkup(pricing: ModelPricing): ModelPricing {
    const multiplier = 1 + Math.max(0, this.markupBps) / 10_000;
    return {
      ...pricing,
      inputUsdPer1M: Number((pricing.inputUsdPer1M * multiplier).toFixed(6)),
      outputUsdPer1M: Number((pricing.outputUsdPer1M * multiplier).toFixed(6)),
    };
  }

  async refreshIfStale(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastRefreshedAt < 10 * 60_000) return;

    try {
      const modelsUrl = this.upstreamBaseUrl.endsWith("/v1")
        ? `${this.upstreamBaseUrl}/models`
        : `${this.upstreamBaseUrl}/v1/models`;
      const res = await fetch(modelsUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: Array<{
          id: string;
          pricing?: { input?: number; output?: number };
        }>;
      };
      if (!Array.isArray(body.data)) return;

      for (const item of body.data) {
        if (!item?.id) continue;
        const input = Number(item.pricing?.input);
        const output = Number(item.pricing?.output);
        if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) {
          this.cache.set(
            item.id,
            this.withMarkup({
              model: item.id,
              inputUsdPer1M: input,
              outputUsdPer1M: output,
              privacy: "private",
            }),
          );
        }
      }
      this.lastRefreshedAt = now;
    } catch {
      // Keep fallback/cached pricing if upstream model list is unreachable
    }
  }

  getPricing(modelId: string): ModelPricing {
    const exact = this.cache.get(modelId);
    if (exact) return exact;

    // Conservative fallback if unknown model requested
    return this.withMarkup({
      model: modelId,
      inputUsdPer1M: 1.0,
      outputUsdPer1M: 3.0,
      privacy: "private",
    });
  }

  listAll(): ModelPricing[] {
    return Array.from(this.cache.values());
  }
}
