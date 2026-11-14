import { IntentsQuotePreview, usdToAtomicUnits } from "@near402/protocol";
import { ProxyConfig } from "./config.js";

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
}

export interface OneClickStatusResponse {
  correlationId?: string;
  status:
    | "PENDING_DEPOSIT"
    | "KNOWN_DEPOSIT_TX"
    | "PROCESSING"
    | "SUCCESS"
    | "INCOMPLETE_DEPOSIT"
    | "REFUNDED"
    | "FAILED";
  quoteResponse?: {
    quoteRequest?: {
      recipient?: string;
      destinationAsset?: string;
      originAsset?: string;
    };
    quote?: {
      amountIn?: string;
      amountOut?: string;
    };
  };
  swapDetails?: {
    amountIn?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    refundReason?: string;
  };
}

export class OneClickClient {
  private tokensCache: OneClickToken[] = [];
  private tokensFetchedAt = 0;

  constructor(private readonly config: ProxyConfig) {}

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.oneClickApiKey) {
      headers.Authorization = `Bearer ${this.config.oneClickApiKey}`;
    }
    return headers;
  }

  async getTokens(force = false): Promise<OneClickToken[]> {
    const now = Date.now();
    if (!force && this.tokensCache.length > 0 && now - this.tokensFetchedAt < 5 * 60_000) {
      return this.tokensCache;
    }

    const res = await fetch(`${this.config.oneClickBaseUrl}/v0/tokens`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`1Click /v0/tokens failed: ${res.status}`);
    }
    const list = (await res.json()) as Array<{
      assetId: string;
      decimals: number;
      blockchain: string;
      symbol: string;
      price: string | number;
      contractAddress?: string;
    }>;

    this.tokensCache = list.map((item) => ({
      assetId: item.assetId,
      decimals: Number(item.decimals),
      blockchain: item.blockchain,
      symbol: item.symbol,
      price: Number(item.price),
      contractAddress: item.contractAddress,
    }));
    this.tokensFetchedAt = now;
    return this.tokensCache;
  }

  async getNearPriceUsd(): Promise<number> {
    try {
      const tokens = await this.getTokens();
      const wnear = tokens.find(
        (t) => t.blockchain === "near" && (t.symbol === "wNEAR" || t.contractAddress === "wrap.near"),
      );
      if (wnear && Number.isFinite(wnear.price) && wnear.price > 0) {
        return wnear.price;
      }
    } catch {
      // Fallback below
    }
    return 3.5;
  }

  async findTokenByAssetId(assetId: string): Promise<OneClickToken | undefined> {
    const tokens = await this.getTokens();
    return tokens.find((t) => t.assetId === assetId);
  }

  async createQuote(params: {
    originAsset: string;
    refundTo: string;
    amountUsd?: number;
    amountIn?: string;
    swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
    destinationAsset?: string;
  }): Promise<{ preview: IntentsQuotePreview; raw: unknown }> {
    const destinationAsset = params.destinationAsset || this.config.usdcAssetId;
    const swapType = params.swapType || "EXACT_INPUT";

    let amount = params.amountIn;
    if (!amount) {
      const usd = Math.max(this.config.minTopUpUsd, params.amountUsd ?? this.config.suggestedTopUpUsd);
      const originToken = await this.findTokenByAssetId(params.originAsset);
      if (!originToken) {
        throw new Error(`Unsupported originAsset: ${params.originAsset}`);
      }
      if (!originToken.price || originToken.price <= 0) {
        throw new Error(`Missing USD price for originAsset: ${params.originAsset}`);
      }
      amount = usdToAtomicUnits(usd, originToken.price, originToken.decimals);
    }

    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();

    const body = {
      dry: false,
      swapType,
      slippageTolerance: 100, // 1%
      originAsset: params.originAsset,
      destinationAsset,
      amount,
      recipient: this.config.sellerAccountId,
      recipientType: "DESTINATION_CHAIN",
      depositType: "ORIGIN_CHAIN",
      refundTo: params.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline,
      quoteWaitingTimeMs: 3000,
      referral: "near402",
    };

    const res = await fetch(`${this.config.oneClickBaseUrl}/v0/quote`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`1Click /v0/quote failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      quote?: {
        depositAddress?: string;
        depositMemo?: string;
        amountIn?: string;
        amountInFormatted?: string;
        amountOut?: string;
        amountOutFormatted?: string;
        minAmountOut?: string;
        deadline?: string;
      };
    };

    if (!data.quote?.depositAddress) {
      throw new Error("1Click /v0/quote did not return a depositAddress");
    }

    return {
      preview: {
        depositAddress: data.quote.depositAddress,
        depositMemo: data.quote.depositMemo,
        amountIn: data.quote.amountIn || amount,
        amountInFormatted: data.quote.amountInFormatted,
        amountOut: data.quote.amountOut || "0",
        amountOutFormatted: data.quote.amountOutFormatted,
        minAmountOut: data.quote.minAmountOut,
        deadline: data.quote.deadline || deadline,
        originAsset: params.originAsset,
        destinationAsset,
      },
      raw: data,
    };
  }

  async submitDeposit(params: {
    txHash: string;
    depositAddress: string;
    nearSenderAccount?: string;
  }): Promise<void> {
    try {
      await fetch(`${this.config.oneClickBaseUrl}/v0/deposit/submit`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best-effort notification to speed up 1Click indexing
    }
  }

  async getStatus(depositAddress: string): Promise<OneClickStatusResponse> {
    const url = `${this.config.oneClickBaseUrl}/v0/status?depositAddress=${encodeURIComponent(
      depositAddress,
    )}`;
    const res = await fetch(url, {
      headers: this.config.oneClickApiKey
        ? { Authorization: `Bearer ${this.config.oneClickApiKey}` }
        : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`1Click /v0/status failed (${res.status}): ${text}`);
    }
    return (await res.json()) as OneClickStatusResponse;
  }
}

