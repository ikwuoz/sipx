import { atomicUnitsToUsd } from "@near402/protocol";
import { ProxyConfig } from "./config.js";
import { OneClickClient } from "./intents.js";
import { SessionLedger } from "./ledger.js";

export type VerifyResult =
  | {
      ok: true;
      rail: "near_direct" | "near_intents";
      txRef: string;
      creditedUsd: number;
      assetSymbol: string;
    }
  | {
      ok: false;
      pending?: true;
      status?: string;
      error: string;
    };

interface NearRpcTxResponse {
  result?: {
    status?: {
      SuccessValue?: string;
      Failure?: unknown;
    };
    transaction?: {
      signer_id?: string;
      receiver_id?: string;
      actions?: Array<{
        Transfer?: { deposit?: string };
        FunctionCall?: {
          method_name?: string;
          args?: string;
          deposit?: string;
        };
      }>;
    };
    receipts_outcome?: Array<{
      outcome?: {
        status?: {
          SuccessValue?: string;
          SuccessReceiptId?: string;
          Failure?: unknown;
        };
      };
    }>;
  };
  error?: {
    message?: string;
    data?: unknown;
  };
}

export class PaymentVerifier {
  constructor(
    private readonly config: ProxyConfig,
    private readonly ledger: SessionLedger,
    private readonly oneClick: OneClickClient,
  ) {}

  async verifyNearDirect(params: {
    txHash: string;
    senderAccountId: string;
  }): Promise<VerifyResult> {
    const txHash = params.txHash.trim();
    const senderAccountId = params.senderAccountId.trim();

    if (!txHash || !senderAccountId) {
      return { ok: false, error: "txHash and senderAccountId are required" };
    }

    const txRef = `near:${txHash}`;
    if (this.ledger.isTxRedeemed(txRef)) {
      return { ok: false, error: `Transaction already redeemed: ${txHash}` };
    }

    const rpcBody = {
      jsonrpc: "2.0",
      id: "near402-verify",
      method: "tx",
      params: {
        tx_hash: txHash,
        sender_account_id: senderAccountId,
        wait_until: "FINAL",
      },
    };

    const res = await fetch(this.config.nearRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      return { ok: false, error: `NEAR RPC error: HTTP ${res.status}` };
    }

    const rpc = (await res.json()) as NearRpcTxResponse;
    if (rpc.error || !rpc.result) {
      return {
        ok: false,
        error: rpc.error?.message || "Transaction not found on NEAR RPC",
      };
    }

    const { status, transaction, receipts_outcome } = rpc.result;
    if (!status || status.Failure !== undefined || status.SuccessValue === undefined) {
      return { ok: false, error: "NEAR transaction failed or not finalized" };
    }

    const hasFailedReceipt = (receipts_outcome || []).some(
      (r) => r.outcome?.status?.Failure !== undefined,
    );
    if (hasFailedReceipt) {
      return { ok: false, error: "One or more transaction receipts failed" };
    }

    if (!transaction?.receiver_id || !Array.isArray(transaction.actions)) {
      return { ok: false, error: "Malformed transaction payload from NEAR RPC" };
    }

    const receiverId = transaction.receiver_id;

    // Case 1: Native NEAR transfer directly to sellerAccountId
    if (receiverId === this.config.sellerAccountId) {
      let totalYocto = 0n;
      for (const action of transaction.actions) {
        if (action.Transfer?.deposit) {
          totalYocto += BigInt(action.Transfer.deposit);
        }
      }
      if (totalYocto <= 0n) {
        return {
          ok: false,
          error: `Transaction to ${receiverId} contained no NEAR transfer deposit`,
        };
      }
      const nearPriceUsd = await this.oneClick.getNearPriceUsd();
      const creditedUsd = atomicUnitsToUsd(totalYocto, nearPriceUsd, 24);
      if (creditedUsd <= 0) {
        return { ok: false, error: "NEAR transfer amount too small to credit" };
      }
      return {
        ok: true,
        rail: "near_direct",
        txRef,
        creditedUsd,
        assetSymbol: "NEAR",
      };
    }

    // Case 2: NEP-141 ft_transfer / ft_transfer_call (USDC, USDT, or wNEAR)
    const tokenSpec = this.resolveAcceptedFt(receiverId);
    if (!tokenSpec) {
      return {
        ok: false,
        error: `Unsupported receiver contract ${receiverId} (expected ${this.config.sellerAccountId} or ${this.config.usdcContractId})`,
      };
    }

    let totalAtomic = 0n;
    for (const action of transaction.actions) {
      const fn = action.FunctionCall;
      if (!fn) continue;
      if (fn.method_name !== "ft_transfer" && fn.method_name !== "ft_transfer_call") {
        continue;
      }
      if (!fn.args) continue;
      try {
        const decoded = JSON.parse(
          Buffer.from(fn.args, "base64").toString("utf8"),
        ) as { receiver_id?: string; amount?: string };
        if (
          decoded.receiver_id === this.config.sellerAccountId &&
          decoded.amount &&
          /^\d+$/.test(decoded.amount)
        ) {
          totalAtomic += BigInt(decoded.amount);
        }
      } catch {
        // Ignore unparseable args
      }
    }

    if (totalAtomic <= 0n) {
      return {
        ok: false,
        error: `No ${tokenSpec.symbol} transfer to ${this.config.sellerAccountId} found in transaction`,
      };
    }

    const priceUsd =
      tokenSpec.symbol === "wNEAR" ? await this.oneClick.getNearPriceUsd() : 1.0;
    const creditedUsd = atomicUnitsToUsd(totalAtomic, priceUsd, tokenSpec.decimals);
    if (creditedUsd <= 0) {
      return { ok: false, error: "Token transfer amount too small to credit" };
    }

    return {
      ok: true,
      rail: "near_direct",
      txRef,
      creditedUsd,
      assetSymbol: tokenSpec.symbol,
    };
  }

  private resolveAcceptedFt(contractId: string): {
    symbol: "USDC" | "USDT" | "wNEAR";
    decimals: number;
  } | null {
    if (contractId === this.config.usdcContractId) {
      return { symbol: "USDC", decimals: 6 };
    }
    if (contractId === this.config.usdtContractId) {
      return { symbol: "USDT", decimals: 6 };
    }
    if (contractId === this.config.wnearContractId) {
      return { symbol: "wNEAR", decimals: 24 };
    }
    return null;
  }

  async verifyNearIntents(params: {
    depositAddress: string;
    txHash?: string;
    senderAccountId?: string;
  }): Promise<VerifyResult> {
    const depositAddress = params.depositAddress.trim();
    if (!depositAddress) {
      return { ok: false, error: "depositAddress is required" };
    }

    const txRef = `intents:${depositAddress}`;
    if (this.ledger.isTxRedeemed(txRef)) {
      return {
        ok: false,
        error: `Intents deposit already redeemed: ${depositAddress}`,
      };
    }

    if (params.txHash) {
      await this.oneClick.submitDeposit({
        txHash: params.txHash,
        depositAddress,
        nearSenderAccount: params.senderAccountId,
      });
    }

    const status = await this.oneClick.getStatus(depositAddress);
    if (
      status.status === "PENDING_DEPOSIT" ||
      status.status === "KNOWN_DEPOSIT_TX" ||
      status.status === "PROCESSING"
    ) {
      return {
        ok: false,
        pending: true,
        status: status.status,
        error: `Swap still ${status.status}`,
      };
    }

    if (status.status !== "SUCCESS") {
      return {
        ok: false,
        status: status.status,
        error:
          status.swapDetails?.refundReason ||
          `1Click swap ended with status ${status.status}`,
      };
    }

    const recordedQuote = this.ledger.getQuote(depositAddress);
    const actualRecipient =
      status.quoteResponse?.quoteRequest?.recipient || recordedQuote?.recipient;
    if (actualRecipient && actualRecipient !== this.config.sellerAccountId) {
      return {
        ok: false,
        error: `Quote recipient ${actualRecipient} does not match seller ${this.config.sellerAccountId}`,
      };
    }

    const destinationAsset =
      status.quoteResponse?.quoteRequest?.destinationAsset ||
      recordedQuote?.destinationAsset ||
      this.config.usdcAssetId;
    const amountOut =
      status.swapDetails?.amountOut ||
      status.quoteResponse?.quote?.amountOut ||
      recordedQuote?.amountOut ||
      "0";

    const destToken = await this.oneClick.findTokenByAssetId(destinationAsset);
    const decimals = destToken?.decimals ?? 6;
    const priceUsd = destToken?.price && destToken.price > 0 ? destToken.price : 1.0;

    const creditedUsd = atomicUnitsToUsd(amountOut, priceUsd, decimals);
    if (creditedUsd <= 0) {
      return { ok: false, error: "Settled swap output amount is zero" };
    }

    return {
      ok: true,
      rail: "near_intents",
      txRef,
      creditedUsd,
      assetSymbol: destToken?.symbol || "USDC",
    };
  }
}

