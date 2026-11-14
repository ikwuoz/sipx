import { Account, KeyPairString } from "near-api-js";
import {
  ChallengeResponseBody,
  NEAR402_TOKEN_PREFIX,
  NearNetwork,
  RedeemResponse,
} from "@near402/protocol";
import {
  createNearAccount,
  loadSessionTokens,
  saveSessionToken,
  WalletKeyType,
} from "./wallet.js";
import { payChallenge, PaymentRail, PreferredAsset } from "./payer.js";
import { SpendGuardrail, SpendPolicy } from "./guardrails.js";

export interface Near402FetchOptions {
  account?: Account;
  accountId?: string;
  privateKey?: KeyPairString;
  keyType?: WalletKeyType;
  network?: NearNetwork;
  rpcUrl?: string;
  rail?: PaymentRail;
  preferredAsset?: PreferredAsset;
  originAsset?: string;
  amountUsd?: number;
  spendPolicy?: SpendPolicy;
  autoClaimTrial?: boolean;
  persistSessions?: boolean;
  sessionsPath?: string;
  baseFetch?: typeof fetch;
  onPayment?: (receipt: RedeemResponse) => void;
  onTrialClaimed?: (trial: { token: string; balanceUsd: number }) => void;
}

export async function claimTrialToken(params: {
  proxyBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ token: string; balanceUsd: number } | null> {
  const fetchFn = params.fetchImpl ?? fetch;
  const origin = new URL(params.proxyBaseUrl).origin;
  try {
    const res = await fetchFn(`${origin}/v1/402/trial`, { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string; balanceUsd?: number };
    if (!data.token) return null;
    return {
      token: data.token,
      balanceUsd: Number(data.balanceUsd ?? 0),
    };
  } catch {
    return null;
  }
}

export function createNear402Fetch(options: Near402FetchOptions): typeof fetch {
  const rawFetch = options.baseFetch ?? fetch;
  const persist = options.persistSessions ?? true;

  const account =
    options.account ??
    (options.accountId && options.privateKey
      ? createNearAccount({
          accountId: options.accountId,
          privateKey: options.privateKey,
          network: options.network,
          rpcUrl: options.rpcUrl,
        })
      : undefined);

  if (!account) {
    throw new Error(
      "createNear402Fetch requires either `account` or both `accountId` and `privateKey`",
    );
  }

  const tokenCache = new Map<string, string>(
    persist ? Object.entries(loadSessionTokens(options.sessionsPath)) : [],
  );
  const inflightPayments = new Map<string, Promise<string>>();
  const guardrail = new SpendGuardrail(options.spendPolicy, persist);

  return async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const reqUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const origin = new URL(reqUrl).origin;

    const buildHeaders = (overrideToken?: string): Headers => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const existingAuth = headers.get("Authorization") || "";
      const hasValidNear402Token =
        existingAuth.includes(NEAR402_TOKEN_PREFIX) ||
        /^near402\s+/i.test(existingAuth);

      const tokenToUse = overrideToken || (!hasValidNear402Token ? tokenCache.get(origin) : undefined);
      if (tokenToUse) {
        headers.set("Authorization", `Bearer ${tokenToUse}`);
      }
      return headers;
    };

    const firstRes = await rawFetch(input, {
      ...init,
      headers: buildHeaders(),
    });

    if (firstRes.status !== 402) {
      return firstRes;
    }

    const challengeBody = (await firstRes.json()) as ChallengeResponseBody;
    if (!challengeBody?.challenge) {
      return new Response(JSON.stringify(challengeBody), {
        status: 402,
        headers: firstRes.headers,
      });
    }

    let payPromise = inflightPayments.get(origin);
    if (!payPromise) {
      payPromise = (async () => {
        const challenge = challengeBody.challenge;
        const recipient = challenge.rails.nearDirect.recipient;

        if (options.autoClaimTrial && !tokenCache.get(origin)) {
          const trial = await claimTrialToken({
            proxyBaseUrl: origin,
            fetchImpl: rawFetch,
          });
          if (trial) {
            tokenCache.set(origin, trial.token);
            if (persist) {
              saveSessionToken(origin, trial.token, options.sessionsPath);
            }
            options.onTrialClaimed?.(trial);
            return trial.token;
          }
        }

        const plannedAmountUsd =
          options.amountUsd ?? (Number(challenge.suggestedTopUpUsd) || 0.1);

        guardrail.assertAllowed({
          origin,
          recipientAccountId: recipient,
          amountUsd: plannedAmountUsd,
        });

        const receipt = await payChallenge({
          proxyBaseUrl: origin,
          challenge,
          account,
          keyType: options.keyType,
          rail: options.rail,
          preferredAsset: options.preferredAsset,
          originAsset: options.originAsset,
          amountUsd: options.amountUsd,
          existingToken: tokenCache.get(origin),
          fetchImpl: rawFetch,
        });
        guardrail.recordSpend({
          origin,
          recipientAccountId: recipient,
          amountUsd: receipt.creditedUsd,
          txRef: receipt.txRef,
          rail: receipt.rail,
        });
        tokenCache.set(origin, receipt.token);
        if (persist) {
          saveSessionToken(origin, receipt.token, options.sessionsPath);
        }
        options.onPayment?.(receipt);
        return receipt.token;
      })().finally(() => {
        inflightPayments.delete(origin);
      });
      inflightPayments.set(origin, payPromise);
    }

    const freshToken = await payPromise;

    return rawFetch(input, {
      ...init,
      headers: buildHeaders(freshToken),
    });
  };
}

