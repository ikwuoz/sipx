import crypto from "node:crypto";
import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  BalanceResponse,
  ChallengeResponseBody,
  extractSessionToken,
  formatWwwAuthenticateHeader,
  IntentsQuoteRequest,
  IntentsQuoteResponse,
  NEAR402_PROTOCOL_VERSION,
  PaymentChallenge,
  RedeemRequest,
  RedeemResponse,
  usdToAtomicUnits,
  estimatePromptTokens,
  calculateTokenCostUsd,
} from "@near402/protocol";
import { loadConfig, PricingCatalog, ProxyConfig } from "./config.js";
import { OneClickClient } from "./intents.js";
import { SessionLedger, SessionRecord } from "./ledger.js";
import { forwardGetPassthrough, forwardInference } from "./upstream.js";
import { PaymentVerifier } from "./verify.js";

export interface ProxyDependencies {
  config?: ProxyConfig;
  ledger?: SessionLedger;
  oneClick?: OneClickClient;
  verifier?: PaymentVerifier;
  pricingCatalog?: PricingCatalog;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readRawJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
): Promise<{ body: T; rawBody: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const trimmed = rawBody.trim();
  if (!trimmed) return { body: {} as T, rawBody };
  return { body: JSON.parse(trimmed) as T, rawBody };
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const { body } = await readRawJsonBody<T>(req);
  return body;
}

export function createProxyServer(deps: ProxyDependencies = {}) {
  const config = deps.config ?? loadConfig();
  const ledger = deps.ledger ?? new SessionLedger(config.sessionSecret, config.ledgerPath);
  const oneClick = deps.oneClick ?? new OneClickClient(config);
  const verifier = deps.verifier ?? new PaymentVerifier(config, ledger, oneClick);
  const pricingCatalog =
    deps.pricingCatalog ?? new PricingCatalog(config.upstreamBaseUrl, config.markupBps);

  // Warm up pricing & token cache without blocking startup
  void pricingCatalog.refreshIfStale(true);

  async function buildChallenge(params: {
    model: string;
    originAsset?: string;
    refundTo?: string;
    amountUsd?: number;
  }): Promise<PaymentChallenge> {
    const pricing = pricingCatalog.getPricing(params.model);
    const challengeId = `ch_${crypto.randomBytes(10).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const nearPriceUsd = await oneClick.getNearPriceUsd();

    ledger.recordChallenge({ challengeId, model: params.model, expiresAt });

    let optionalQuote;
    if (params.originAsset && params.refundTo) {
      try {
        const quoted = await oneClick.createQuote({
          originAsset: params.originAsset,
          refundTo: params.refundTo,
          amountUsd: params.amountUsd ?? config.suggestedTopUpUsd,
        });
        ledger.recordQuote({
          depositAddress: quoted.preview.depositAddress,
          originAsset: quoted.preview.originAsset,
          destinationAsset: quoted.preview.destinationAsset,
          recipient: config.sellerAccountId,
          amountOut: quoted.preview.amountOut,
          createdAt: new Date().toISOString(),
        });
        optionalQuote = quoted.preview;
      } catch {
        // Buyer can still call POST /v1/402/quote explicitly
      }
    }

    return {
      protocol: NEAR402_PROTOCOL_VERSION,
      challengeId,
      model: params.model,
      pricing: {
        inputUsdPer1M: pricing.inputUsdPer1M,
        outputUsdPer1M: pricing.outputUsdPer1M,
        currency: "USD",
      },
      minTopUpUsd: config.minTopUpUsd.toFixed(2),
      suggestedTopUpUsd: config.suggestedTopUpUsd.toFixed(2),
      expiresAt,
      redeemUrl: "/v1/402/redeem",
      rails: {
        nearDirect: {
          network: config.nearNetwork,
          recipient: config.sellerAccountId,
          acceptedAssets: [
            {
              symbol: "USDC",
              assetId: config.usdcAssetId,
              contractAddress: config.usdcContractId,
              decimals: 6,
              priceUsd: 1,
              minAmount: usdToAtomicUnits(config.minTopUpUsd, 1, 6),
              suggestedAmount: usdToAtomicUnits(config.suggestedTopUpUsd, 1, 6),
            },
            {
              symbol: "NEAR",
              assetId: "near:native",
              decimals: 24,
              priceUsd: nearPriceUsd,
              minAmount: usdToAtomicUnits(config.minTopUpUsd, nearPriceUsd, 24),
              suggestedAmount: usdToAtomicUnits(config.suggestedTopUpUsd, nearPriceUsd, 24),
            },
          ],
        },
        nearIntents: {
          provider: "1click",
          quoteUrl: "/v1/402/quote",
          destinationAsset: config.usdcAssetId,
          destinationRecipient: config.sellerAccountId,
          ...(optionalQuote ? { quote: optionalQuote } : {}),
        },
      },
    };
  }

  async function handleRedeem(
    body: RedeemRequest,
    res: ServerResponse,
  ): Promise<{ session: SessionRecord; token: string } | null> {
    if (body.rail === "near_direct") {
      const result = await verifier.verifyNearDirect({
        txHash: body.txHash,
        senderAccountId: body.senderAccountId,
      });
      if (!result.ok) {
        sendJson(res, 400, { error: { code: "invalid_payment", message: result.error } });
        return null;
      }
      const { session, token } = ledger.creditPayment({
        txRef: result.txRef,
        amountUsd: result.creditedUsd,
        existingToken: body.token,
      });
      const response: RedeemResponse = {
        token,
        sessionId: session.sessionId,
        creditedUsd: result.creditedUsd,
        balanceUsd: session.balanceUsd,
        rail: "near_direct",
        txRef: result.txRef,
        header: `Authorization: Bearer ${token}`,
      };
      sendJson(res, 200, response);
      return { session, token };
    }

    if (body.rail === "near_intents") {
      const result = await verifier.verifyNearIntents({
        depositAddress: body.depositAddress,
        txHash: body.txHash,
        senderAccountId: body.senderAccountId,
      });
      if (!result.ok) {
        if (result.pending) {
          sendJson(res, 202, {
            status: result.status,
            depositAddress: body.depositAddress,
            retryAfterMs: 2000,
          });
          return null;
        }
        sendJson(res, 400, { error: { code: "invalid_payment", message: result.error } });
        return null;
      }
      const { session, token } = ledger.creditPayment({
        txRef: result.txRef,
        amountUsd: result.creditedUsd,
        existingToken: body.token,
      });
      const response: RedeemResponse = {
        token,
        sessionId: session.sessionId,
        creditedUsd: result.creditedUsd,
        balanceUsd: session.balanceUsd,
        rail: "near_intents",
        txRef: result.txRef,
        header: `Authorization: Bearer ${token}`,
      };
      sendJson(res, 200, response);
      return { session, token };
    }

    sendJson(res, 400, { error: { code: "unsupported_rail", message: "Unknown rail" } });
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Expose-Headers": "*",
        });
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
        sendJson(res, 200, {
          service: "sipx-near402",
          protocol: NEAR402_PROTOCOL_VERSION,
          network: config.nearNetwork,
          sellerAccountId: config.sellerAccountId,
          defaultModel: config.defaultModel,
          upstreamConfigured: Boolean(config.nearAiApiKey),
          freeAllowanceUsd: config.freeAllowanceUsd,
          pricing: pricingCatalog.getPricing(config.defaultModel),
          endpoints: {
            playground: "/playground",
            chatCompletions: "/v1/chat/completions",
            models: "/v1/models",
            quote: "/v1/402/quote",
            redeem: "/v1/402/redeem",
            balance: "/v1/402/balance",
            trial: "/v1/402/trial",
            attestation: "/v1/attestation/report",
            signature: "/v1/signature/{chat_id}",
          },
        });
        return;
      }

      if (req.method === "GET" && pathname === "/playground") {
        const htmlPath = fileURLToPath(
          new URL("../public/playground.html", import.meta.url),
        );
        if (!fs.existsSync(htmlPath)) {
          sendJson(res, 404, {
            error: { code: "not_found", message: "Playground UI not found" },
          });
          return;
        }
        const html = fs.readFileSync(htmlPath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        await pricingCatalog.refreshIfStale();
        sendJson(res, 200, {
          object: "list",
          data: pricingCatalog.listAll().map((p) => ({
            id: p.model,
            object: "model",
            owned_by: p.model.split("/")[0] || "near-ai",
            near402_pricing: {
              input_usd_per_1m: p.inputUsdPer1M,
              output_usd_per_1m: p.outputUsdPer1M,
              privacy: p.privacy,
            },
          })),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/402/balance") {
        const token = extractSessionToken(req.headers.authorization);
        const session = token ? ledger.verifyToken(token) : null;
        if (!session) {
          sendJson(res, 401, {
            error: { code: "unauthorized", message: "Missing or invalid near402 token" },
          });
          return;
        }
        const payload: BalanceResponse = {
          sessionId: session.sessionId,
          balanceUsd: session.balanceUsd,
          totalCreditedUsd: session.totalCreditedUsd,
          totalSpentUsd: session.totalSpentUsd,
          requestsCount: session.requestsCount,
        };
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/402/trial") {
        if (config.freeAllowanceUsd <= 0) {
          sendJson(res, 403, {
            error: { code: "trial_disabled", message: "Free trial allowance is disabled" },
          });
          return;
        }
        const clientIp =
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";
        const granted = ledger.claimTrialAllowance(clientIp, config.freeAllowanceUsd);
        if (!granted) {
          sendJson(res, 429, {
            error: {
              code: "trial_exhausted",
              message: "Trial allowance already claimed for this IP",
            },
          });
          return;
        }
        sendJson(res, 200, {
          token: granted.token,
          sessionId: granted.session.sessionId,
          balanceUsd: granted.session.balanceUsd,
          header: `Authorization: Bearer ${granted.token}`,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/402/quote") {
        const body = await readJsonBody<IntentsQuoteRequest>(req);
        if (!body.originAsset || !body.refundTo) {
          sendJson(res, 400, {
            error: {
              code: "bad_request",
              message: "originAsset and refundTo are required",
            },
          });
          return;
        }
        const quoted = await oneClick.createQuote({
          originAsset: body.originAsset,
          refundTo: body.refundTo,
          amountUsd: body.amountUsd,
          amountIn: body.amountIn,
          swapType: body.swapType,
        });
        ledger.recordQuote({
          depositAddress: quoted.preview.depositAddress,
          originAsset: quoted.preview.originAsset,
          destinationAsset: quoted.preview.destinationAsset,
          recipient: config.sellerAccountId,
          amountOut: quoted.preview.amountOut,
          createdAt: new Date().toISOString(),
        });
        const resp: IntentsQuoteResponse = {
          challengeId: body.challengeId,
          quote: quoted.preview,
        };
        sendJson(res, 200, resp);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/402/redeem") {
        const body = await readJsonBody<RedeemRequest>(req);
        await handleRedeem(body, res);
        return;
      }

      // Free TEE verification pass-through endpoints (no buyer API key needed)
      if (
        req.method === "GET" &&
        (pathname === "/v1/attestation/report" || pathname.startsWith("/v1/signature/"))
      ) {
        await forwardGetPassthrough({
          config,
          req,
          res,
          upstreamPathWithQuery: `${pathname}${url.search}`,
        });
        return;
      }

      // Paid inference endpoints
      if (
        req.method === "POST" &&
        (pathname === "/v1/chat/completions" ||
          pathname === "/v1/responses" ||
          pathname === "/v1/embeddings")
      ) {
        const { body: bodyObj, rawBody } = await readRawJsonBody<Record<string, unknown>>(req);
        const hadModel = typeof bodyObj.model === "string" && bodyObj.model.trim().length > 0;
        const model = hadModel ? (bodyObj.model as string).trim() : config.defaultModel;
        let bodyMutated = !hadModel;
        if (!hadModel) {
          bodyObj.model = model;
        }

        const pricing = pricingCatalog.getPricing(model);
        const estimatedInput = estimatePromptTokens(bodyObj);
        const minRequiredUsd = Math.max(
          0.000001,
          calculateTokenCostUsd(pricing, estimatedInput, 1),
        );

        let token = extractSessionToken(req.headers.authorization);
        let session = token ? ledger.verifyToken(token) : null;

        // Optional single-shot header: X-402-Payment: near_direct:<txHash>:<senderAccountId>
        const singleShotHeader = req.headers["x-402-payment"];
        if (!session && typeof singleShotHeader === "string" && singleShotHeader.trim()) {
          const parts = singleShotHeader.trim().split(":");
          if (parts[0] === "near_direct" && parts[1] && parts[2]) {
            const vr = await verifier.verifyNearDirect({
              txHash: parts[1],
              senderAccountId: parts[2],
            });
            if (vr.ok) {
              const credited = ledger.creditPayment({
                txRef: vr.txRef,
                amountUsd: vr.creditedUsd,
              });
              session = credited.session;
              token = credited.token;
            }
          } else if (parts[0] === "near_intents" && parts[1]) {
            const vr = await verifier.verifyNearIntents({
              depositAddress: parts[1],
              txHash: parts[2],
            });
            if (vr.ok) {
              const credited = ledger.creditPayment({
                txRef: vr.txRef,
                amountUsd: vr.creditedUsd,
              });
              session = credited.session;
              token = credited.token;
            }
          }
        }

        if (!session || session.balanceUsd < minRequiredUsd) {
          const originAsset = req.headers["x-402-origin-asset"];
          const refundTo = req.headers["x-402-refund-to"];
          const challenge = await buildChallenge({
            model,
            originAsset: typeof originAsset === "string" ? originAsset : undefined,
            refundTo: typeof refundTo === "string" ? refundTo : undefined,
          });
          const body: ChallengeResponseBody = {
            error: {
              code: "payment_required",
              message: session
                ? `Insufficient balance ($${session.balanceUsd.toFixed(6)} USD remaining). Top up via NEAR direct or NEAR Intents 1Click.`
                : "Payment required. Pay via NEAR direct or NEAR Intents 1Click, then redeem at /v1/402/redeem.",
              ...(session ? { currentBalanceUsd: session.balanceUsd } : {}),
            },
            challenge,
          };
          sendJson(res, 402, body, {
            "WWW-Authenticate": formatWwwAuthenticateHeader(challenge),
          });
          return;
        }

        if (!config.nearAiApiKey) {
          sendJson(res, 503, {
            error: {
              code: "upstream_not_configured",
              message: "Seller NEAR_AI_API_KEY is not configured",
            },
          });
          return;
        }

        const inputCostUsd = calculateTokenCostUsd(pricing, estimatedInput, 0);
        const availableForOutputUsd = Math.max(0, session.balanceUsd - inputCostUsd);
        const affordableOutputTokens = Math.max(
          1,
          Math.floor(
            (availableForOutputUsd * 1_000_000) / Math.max(pricing.outputUsdPer1M, 0.0001),
          ),
        );
        const requestedMax = Number(
          bodyObj.max_tokens ?? bodyObj.max_completion_tokens,
        );
        const hasValidRequestedMax = Number.isFinite(requestedMax) && requestedMax > 0;
        const maxAllowed = Math.min(affordableOutputTokens, config.maxOutputTokensCap);
        const effectiveMaxTokens = hasValidRequestedMax
          ? Math.min(Math.floor(requestedMax), maxAllowed)
          : maxAllowed;

        const outboundBody: Record<string, unknown> = { ...bodyObj };
        if (pathname !== "/v1/embeddings") {
          const needsClampOrInject =
            !hasValidRequestedMax || Math.floor(requestedMax) > maxAllowed;
          if (needsClampOrInject) {
            bodyMutated = true;
            if (outboundBody.max_completion_tokens !== undefined) {
              outboundBody.max_completion_tokens = effectiveMaxTokens;
            } else {
              outboundBody.max_tokens = effectiveMaxTokens;
            }
          }
        }

        const reserveTargetUsd = calculateTokenCostUsd(
          pricing,
          estimatedInput,
          pathname === "/v1/embeddings" ? 0 : effectiveMaxTokens,
        );
        const reservedUsd = ledger.reserveBalance(session.sessionId, reserveTargetUsd);

        await forwardInference({
          config,
          ledger,
          session,
          pricing,
          endpointPath: pathname,
          bodyObj: outboundBody,
          rawBody,
          bodyMutated,
          res,
          reservedUsd,
        });
        return;
      }

      sendJson(res, 404, {
        error: { code: "not_found", message: `Route not found: ${req.method} ${pathname}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: "internal_error", message } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return {
    server,
    config,
    ledger,
    oneClick,
    verifier,
    pricingCatalog,
  };
}

