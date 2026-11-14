export type NearNetwork = "mainnet" | "testnet";

export const NEAR402_PROTOCOL_VERSION = "near402/v1";
export const NEAR402_TOKEN_PREFIX = "near402_";

export const NEAR_USDC_CONTRACT_MAINNET =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_USDC_ASSET_ID_MAINNET = `nep141:${NEAR_USDC_CONTRACT_MAINNET}`;
export const NEAR_USDT_CONTRACT_MAINNET = "usdt.tether-token.near";
export const NEAR_USDT_ASSET_ID_MAINNET = `nep141:${NEAR_USDT_CONTRACT_MAINNET}`;
export const NEAR_WNEAR_CONTRACT_MAINNET = "wrap.near";
export const NEAR_WNEAR_ASSET_ID_MAINNET = `nep141:${NEAR_WNEAR_CONTRACT_MAINNET}`;

export const DEFAULT_MODEL_ID = "Qwen/Qwen3-VL-30B-A3B-Instruct";

export interface ModelPricing {
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  privacy: "private" | "anonymised";
}

export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "Qwen/Qwen3-VL-30B-A3B-Instruct": {
    model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.55,
    privacy: "private",
  },
  "Qwen/Qwen3.6-35B-A3B-FP8": {
    model: "Qwen/Qwen3.6-35B-A3B-FP8",
    inputUsdPer1M: 0.17,
    outputUsdPer1M: 1.1,
    privacy: "private",
  },
  "Qwen/Qwen3.8-27B": {
    model: "Qwen/Qwen3.8-27B",
    inputUsdPer1M: 0.04,
    outputUsdPer1M: 1.35,
    privacy: "private",
  },
  "deepseek/deepseek-v4.1-flash": {
    model: "deepseek/deepseek-v4.1-flash",
    inputUsdPer1M: 0.3,
    outputUsdPer1M: 1.2,
    privacy: "private",
  },
  "z-ai/glm-5.3-flash": {
    model: "z-ai/glm-5.3-flash",
    inputUsdPer1M: 0.08,
    outputUsdPer1M: 0.5,
    privacy: "private",
  },
  // Legacy / alias IDs referenced in NEAR AI docs
  "Qwen/Qwen3-30B-A3B-Instruct-2507": {
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.55,
    privacy: "private",
  },
  "deepseek-ai/DeepSeek-V3.1": {
    model: "deepseek-ai/DeepSeek-V3.1",
    inputUsdPer1M: 1.05,
    outputUsdPer1M: 3.1,
    privacy: "private",
  },
};

export interface NearDirectAsset {
  symbol: "USDC" | "USDT" | "NEAR" | "wNEAR";
  assetId: string;
  contractAddress?: string;
  decimals: number;
  priceUsd: number;
  minAmount: string;
  suggestedAmount: string;
}

export interface IntentsQuotePreview {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted?: string;
  amountOut: string;
  amountOutFormatted?: string;
  minAmountOut?: string;
  deadline?: string;
  originAsset: string;
  destinationAsset: string;
}

export interface PaymentChallenge {
  protocol: typeof NEAR402_PROTOCOL_VERSION;
  challengeId: string;
  model: string;
  pricing: {
    inputUsdPer1M: number;
    outputUsdPer1M: number;
    currency: "USD";
  };
  minTopUpUsd: string;
  suggestedTopUpUsd: string;
  expiresAt: string;
  redeemUrl: string;
  rails: {
    nearDirect: {
      network: NearNetwork;
      recipient: string;
      acceptedAssets: NearDirectAsset[];
    };
    nearIntents: {
      provider: "1click";
      quoteUrl: string;
      destinationAsset: string;
      destinationRecipient: string;
      quote?: IntentsQuotePreview;
    };
  };
}

export interface ChallengeResponseBody {
  error: {
    code: "payment_required";
    message: string;
    currentBalanceUsd?: number;
  };
  challenge: PaymentChallenge;
}

export interface IntentsQuoteRequest {
  challengeId?: string;
  originAsset: string;
  refundTo: string;
  amountUsd?: number;
  amountIn?: string;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
}

export interface IntentsQuoteResponse {
  challengeId?: string;
  quote: IntentsQuotePreview;
  raw?: unknown;
}

export type RedeemRequest =
  | {
      rail: "near_direct";
      txHash: string;
      senderAccountId: string;
      challengeId?: string;
      token?: string;
    }
  | {
      rail: "near_intents";
      depositAddress: string;
      txHash?: string;
      senderAccountId?: string;
      challengeId?: string;
      token?: string;
    };

export interface RedeemResponse {
  token: string;
  sessionId: string;
  creditedUsd: number;
  balanceUsd: number;
  rail: "near_direct" | "near_intents";
  txRef: string;
  header: string;
}

export interface RedeemPendingResponse {
  status: "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING";
  depositAddress: string;
  retryAfterMs: number;
}

export interface BalanceResponse {
  sessionId: string;
  balanceUsd: number;
  totalCreditedUsd: number;
  totalSpentUsd: number;
  requestsCount: number;
}

export function calculateTokenCostUsd(
  pricing: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M">,
  promptTokens: number,
  completionTokens: number,
): number {
  const inputCost = (Math.max(0, promptTokens) * pricing.inputUsdPer1M) / 1_000_000;
  const outputCost = (Math.max(0, completionTokens) * pricing.outputUsdPer1M) / 1_000_000;
  return Number((inputCost + outputCost).toFixed(8));
}

export function estimatePromptTokens(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 16;
  const record = payload as Record<string, unknown>;
  let charCount = 0;

  if (Array.isArray(record.messages)) {
    for (const msg of record.messages) {
      if (msg && typeof msg === "object") {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string") {
          charCount += content.length + 16;
        } else if (content != null) {
          charCount += JSON.stringify(content).length + 16;
        }
      }
    }
  } else if (typeof record.input === "string") {
    charCount = record.input.length;
  } else if (typeof record.prompt === "string") {
    charCount = record.prompt.length;
  } else {
    charCount = JSON.stringify(payload).length;
  }

  return Math.max(8, Math.ceil(charCount / 4));
}

export function usdToAtomicUnits(usd: number, priceUsd: number, decimals: number): string {
  if (usd <= 0 || priceUsd <= 0) return "0";
  const tokenAmount = usd / priceUsd;
  // Use string math for high-decimal assets like 24-decimal NEAR without floating point overflow
  const fixed = tokenAmount.toFixed(Math.min(decimals, 12));
  const [wholePart, fracPart = ""] = fixed.split(".");
  const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const raw = `${wholePart}${paddedFrac}`.replace(/^0+/, "") || "0";
  return raw;
}

export function atomicUnitsToUsd(
  atomicAmount: string | bigint,
  priceUsd: number,
  decimals: number,
): number {
  const str = typeof atomicAmount === "bigint" ? atomicAmount.toString() : atomicAmount;
  if (!/^\d+$/.test(str)) return 0;
  const padded = str.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  const numeric = Number(`${whole}.${frac}`);
  return Number((numeric * priceUsd).toFixed(8));
}

export function formatWwwAuthenticateHeader(challenge: PaymentChallenge): string {
  return [
    `NEAR402 protocol="${challenge.protocol}"`,
    `challengeId="${challenge.challengeId}"`,
    `model="${challenge.model}"`,
    `amountUsd="${challenge.suggestedTopUpUsd}"`,
    `redeemUrl="${challenge.redeemUrl}"`,
    `expiresAt="${challenge.expiresAt}"`,
  ].join(", ");
}

export function extractSessionToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (/^near402\s+/i.test(trimmed)) {
    const token = trimmed.replace(/^near402\s+/i, "").trim();
    return token || null;
  }
  if (/^bearer\s+/i.test(trimmed)) {
    const token = trimmed.replace(/^bearer\s+/i, "").trim();
    if (token.startsWith(NEAR402_TOKEN_PREFIX)) {
      return token;
    }
  }
  return null;
}

