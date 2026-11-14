import { Account, actions } from "near-api-js";
import { FungibleToken, NEAR } from "near-api-js/tokens";
import {
  IntentsQuotePreview,
  IntentsQuoteResponse,
  NEAR_WNEAR_ASSET_ID_MAINNET,
  NEAR_WNEAR_CONTRACT_MAINNET,
  PaymentChallenge,
  RedeemPendingResponse,
  RedeemResponse,
} from "@near402/protocol";
import { WalletKeyType } from "./wallet.js";

export type PreferredAsset = "auto" | "USDC" | "NEAR";
export type PaymentRail = "near_direct" | "near_intents";

/** Minimum liquid NEAR (~0.005 NEAR) needed to pay tx gas + 1 yoctoNEAR NEP-141 ft_transfer deposit. */
export const MIN_GAS_RESERVE_YOCTO = 5_000_000_000_000_000_000_000n;

export class InsufficientGasError extends Error {
  readonly accountId: string;
  readonly availableNearYocto: bigint;
  readonly fundUrl: string;

  constructor(params: {
    accountId: string;
    availableNearYocto: bigint;
    fundUrl: string;
    reason: string;
  }) {
    super(params.reason);
    this.name = "InsufficientGasError";
    this.accountId = params.accountId;
    this.availableNearYocto = params.availableNearYocto;
    this.fundUrl = params.fundUrl;
  }
}

async function checkNativeGasBalance(account: Account): Promise<{
  known: boolean;
  activated: boolean;
  availableYocto: bigint;
}> {
  if (typeof account.getState !== "function") {
    return { known: false, activated: true, availableYocto: MIN_GAS_RESERVE_YOCTO };
  }
  try {
    const state = (await account.getState()) as {
      balance?: { available?: bigint | string };
      amount?: bigint | string;
    };
    const rawAvailable = state?.balance?.available ?? state?.amount ?? 0n;
    const availableYocto = typeof rawAvailable === "bigint" ? rawAvailable : BigInt(rawAvailable);
    return { known: true, activated: true, availableYocto };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("does not exist") ||
      msg.includes("UNKNOWN_ACCOUNT") ||
      msg.includes("AccountNotFound")
    ) {
      return { known: true, activated: false, availableYocto: 0n };
    }
    return { known: false, activated: true, availableYocto: MIN_GAS_RESERVE_YOCTO };
  }
}

export interface PayChallengeOptions {
  proxyBaseUrl: string;
  challenge: PaymentChallenge;
  account: Account;
  keyType?: WalletKeyType;
  rail?: PaymentRail;
  preferredAsset?: PreferredAsset;
  originAsset?: string;
  refundTo?: string;
  amountUsd?: number;
  existingToken?: string;
  fetchImpl?: typeof fetch;
  onExternalDeposit?: (quote: IntentsQuotePreview) => Promise<string | void>;
}

function extractTxHash(txRes: unknown): string {
  const r = txRes as {
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
  };
  const hash = r?.transaction?.hash || r?.transaction_outcome?.id;
  if (!hash) {
    throw new Error("Could not extract transaction hash from NEAR RPC response");
  }
  return hash;
}

export async function payChallenge(
  options: PayChallengeOptions,
): Promise<RedeemResponse> {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.proxyBaseUrl.replace(/\/+$/, "");
  const rail: PaymentRail = options.rail ?? "near_direct";

  if (rail === "near_direct") {
    return payNearDirect({ ...options, baseUrl, fetchFn });
  }

  return payNearIntents({ ...options, baseUrl, fetchFn });
}

async function payNearDirect(
  options: PayChallengeOptions & { baseUrl: string; fetchFn: typeof fetch },
): Promise<RedeemResponse> {
  const { challenge, account, baseUrl, fetchFn } = options;
  const preferred = options.preferredAsset ?? "auto";
  const recipient = challenge.rails.nearDirect.recipient;
  const assets = challenge.rails.nearDirect.acceptedAssets;

  const usdcInfo = assets.find((a) => a.symbol === "USDC" && a.contractAddress);
  const nearInfo = assets.find((a) => a.symbol === "NEAR");

  const gasKeyPowered =
    options.keyType === "gas_key_full_access" ||
    options.keyType === "gas_key_function_call";
  const gasCheck = gasKeyPowered
    ? { known: false, activated: true, availableYocto: MIN_GAS_RESERVE_YOCTO }
    : await checkNativeGasBalance(account);
  const nearFundUrl = `${baseUrl}/playground?fund=${encodeURIComponent(account.accountId)}&asset=NEAR`;

  let selectedAsset: "USDC" | "NEAR" = "NEAR";
  let txHash: string;
  let usdcBalanceKnown = 0n;

  if (preferred === "USDC") {
    selectedAsset = "USDC";
  } else if (preferred === "NEAR") {
    selectedAsset = "NEAR";
  } else {
    // Auto: prefer USDC if balance >= suggestedAmount AND account has gas reserve
    if (usdcInfo?.contractAddress) {
      const usdcToken = new FungibleToken(usdcInfo.contractAddress, {
        name: "USD Coin",
        symbol: "USDC",
        decimals: usdcInfo.decimals,
      });
      try {
        usdcBalanceKnown = await account.getBalance(usdcToken);
        const needed = BigInt(usdcInfo.suggestedAmount);
        if (usdcBalanceKnown >= needed) {
          if (gasCheck.known && (!gasCheck.activated || gasCheck.availableYocto < MIN_GAS_RESERVE_YOCTO)) {
            throw new InsufficientGasError({
              accountId: account.accountId,
              availableNearYocto: gasCheck.availableYocto,
              fundUrl: nearFundUrl,
              reason:
                `Account ${account.accountId} has ${(Number(usdcBalanceKnown) / 10 ** usdcInfo.decimals).toFixed(4)} USDC ` +
                `but ${gasCheck.activated ? "less than 0.005 NEAR" : "0 NEAR (unactivated implicit account)"} for ft_transfer gas + 1 yoctoNEAR deposit. ` +
                `Top up >= 0.02 NEAR once at ${nearFundUrl}`,
            });
          }
          selectedAsset = "USDC";
        } else {
          selectedAsset = "NEAR";
        }
      } catch (err) {
        if (err instanceof InsufficientGasError) throw err;
        selectedAsset = "NEAR";
      }
    }
  }

  const sendTransfer = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      return extractTxHash(await fn());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      if (
        name.includes("AccessKeyDoesNotExist") ||
        msg.includes("does not exist") ||
        msg.includes("AccessKeyDoesNotExist")
      ) {
        throw new Error(
          `Agent account ${account.accountId} has no active access key / NEAR balance on-chain yet. ` +
            `Fund it once with >= 0.02 NEAR at ${nearFundUrl} (original error: ${msg})`,
        );
      }
      throw err;
    }
  };

  if (selectedAsset === "USDC") {
    if (options.keyType === "function_call") {
      throw new Error(
        "Standard FunctionCall keys cannot attach the 1 yoctoNEAR deposit required by NEP-141 ft_transfer. Provision a `gas_key_full` agent key instead (`near402 key provision --mode gas_key_full`).",
      );
    }
    if (gasCheck.known && (!gasCheck.activated || gasCheck.availableYocto < MIN_GAS_RESERVE_YOCTO)) {
      throw new InsufficientGasError({
        accountId: account.accountId,
        availableNearYocto: gasCheck.availableYocto,
        fundUrl: nearFundUrl,
        reason:
          `Account ${account.accountId} cannot pay USDC ft_transfer gas: ` +
          `${gasCheck.activated ? "available NEAR < 0.005" : "unactivated implicit account (0 NEAR)"}. ` +
          `Fund >= 0.02 NEAR at ${nearFundUrl}`,
      });
    }
    if (!usdcInfo?.contractAddress) {
      throw new Error("Seller 402 challenge did not include a USDC contract address");
    }
    const usdcToken = new FungibleToken(usdcInfo.contractAddress, {
      name: "USD Coin",
      symbol: "USDC",
      decimals: usdcInfo.decimals,
    });
    const amount = BigInt(usdcInfo.suggestedAmount);
    txHash = await sendTransfer(() =>
      account.transfer({
        token: usdcToken,
        receiverId: recipient,
        amount,
      }),
    );
  } else {
    if (
      options.keyType === "function_call" ||
      options.keyType === "gas_key_function_call"
    ) {
      throw new Error(
        `Scoped ${options.keyType} keys cannot perform native NEAR transfers. Use a gas_key_full agent key or fund the key for USDC.`,
      );
    }
    if (!nearInfo) {
      throw new Error("Seller 402 challenge did not include native NEAR option");
    }
    const amount = BigInt(nearInfo.suggestedAmount);
    txHash = await sendTransfer(() =>
      account.transfer({
        token: NEAR,
        receiverId: recipient,
        amount,
      }),
    );
  }

  const redeemUrl = `${baseUrl}${challenge.redeemUrl}`;
  const redeemRes = await fetchFn(redeemUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rail: "near_direct",
      txHash,
      senderAccountId: account.accountId,
      challengeId: challenge.challengeId,
      token: options.existingToken,
    }),
  });

  if (!redeemRes.ok) {
    const errText = await redeemRes.text();
    throw new Error(`402 redeem failed (${redeemRes.status}): ${errText}`);
  }

  return (await redeemRes.json()) as RedeemResponse;
}

async function payNearIntents(
  options: PayChallengeOptions & { baseUrl: string; fetchFn: typeof fetch },
): Promise<RedeemResponse> {
  const { challenge, account, baseUrl, fetchFn } = options;
  const originAsset = options.originAsset ?? NEAR_WNEAR_ASSET_ID_MAINNET;
  const refundTo = options.refundTo ?? account.accountId;

  let quote = challenge.rails.nearIntents.quote;
  if (!quote) {
    const quoteRes = await fetchFn(`${baseUrl}${challenge.rails.nearIntents.quoteUrl}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        originAsset,
        refundTo,
        amountUsd: options.amountUsd ?? Number(challenge.suggestedTopUpUsd),
      }),
    });
    if (!quoteRes.ok) {
      throw new Error(
        `1Click quote request failed (${quoteRes.status}): ${await quoteRes.text()}`,
      );
    }
    const data = (await quoteRes.json()) as IntentsQuoteResponse;
    quote = data.quote;
  }

  let depositTxHash: string | undefined;

  if (options.onExternalDeposit) {
    const maybeHash = await options.onExternalDeposit(quote);
    if (typeof maybeHash === "string") depositTxHash = maybeHash;
  } else if (originAsset === NEAR_WNEAR_ASSET_ID_MAINNET) {
    // Wrap native NEAR into wNEAR and ft_transfer to the 1Click deposit address
    const txRes = await account.signAndSendTransaction({
      receiverId: NEAR_WNEAR_CONTRACT_MAINNET,
      actions: [
        actions.functionCall(
          "near_deposit",
          {},
          30_000_000_000_000n,
          BigInt(quote.amountIn),
        ),
        actions.functionCall(
          "ft_transfer",
          {
            receiver_id: quote.depositAddress,
            amount: quote.amountIn,
          },
          50_000_000_000_000n,
          1n,
        ),
      ],
    });
    depositTxHash = extractTxHash(txRes);
  } else if (originAsset.startsWith("nep141:") && !originAsset.endsWith(".omft.near")) {
    const contractId = originAsset.slice("nep141:".length);
    const ft = new FungibleToken(contractId, {
      name: contractId,
      symbol: "FT",
      decimals: 6,
    });
    const txRes = await account.transfer({
      token: ft,
      receiverId: quote.depositAddress,
      amount: BigInt(quote.amountIn),
    });
    depositTxHash = extractTxHash(txRes);
  } else {
    throw new Error(
      `Cross-chain deposit required for ${originAsset}: send ${quote.amountIn} to ${quote.depositAddress} (provide onExternalDeposit callback)`,
    );
  }

  const redeemUrl = `${baseUrl}${challenge.redeemUrl}`;
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await fetchFn(redeemUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rail: "near_intents",
        depositAddress: quote.depositAddress,
        txHash: depositTxHash,
        senderAccountId: account.accountId,
        challengeId: challenge.challengeId,
        token: options.existingToken,
      }),
    });

    if (res.status === 200) {
      return (await res.json()) as RedeemResponse;
    }

    if (res.status === 202) {
      const pending = (await res.json()) as RedeemPendingResponse;
      await new Promise((r) => setTimeout(r, pending.retryAfterMs || 2000));
      continue;
    }

    throw new Error(`1Click redeem failed (${res.status}): ${await res.text()}`);
  }

  throw new Error("Timed out waiting for NEAR Intents 1Click settlement");
}

