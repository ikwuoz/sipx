import crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import {
  calculateTokenCostUsd,
  estimatePromptTokens,
  ModelPricing,
} from "@near402/protocol";
import { ProxyConfig } from "./config.js";
import { SessionLedger, SessionRecord } from "./ledger.js";

export interface ForwardResult {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  chatId?: string;
}

export function buildUpstreamUrl(baseUrl: string, pathWithQuery: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  if (cleanBase.endsWith("/v1") && pathWithQuery.startsWith("/v1/")) {
    return `${cleanBase}${pathWithQuery.slice(3)}`;
  }
  return `${cleanBase}${pathWithQuery}`;
}

export async function forwardInference(params: {
  config: ProxyConfig;
  ledger: SessionLedger;
  session: SessionRecord;
  pricing: ModelPricing;
  endpointPath: string;
  bodyObj: Record<string, unknown>;
  rawBody?: string;
  bodyMutated?: boolean;
  res: ServerResponse;
  reservedUsd?: number;
}): Promise<void> {
  const {
    config,
    ledger,
    session,
    pricing,
    endpointPath,
    bodyObj,
    rawBody,
    bodyMutated = false,
    res,
    reservedUsd = 0,
  } = params;

  const isStream = bodyObj.stream === true;
  let didMutate = bodyMutated;
  const outgoingBody: Record<string, unknown> = { ...bodyObj };
  if (isStream && endpointPath.includes("chat/completions")) {
    const existingOpts =
      outgoingBody.stream_options && typeof outgoingBody.stream_options === "object"
        ? (outgoingBody.stream_options as Record<string, unknown>)
        : {};
    if (existingOpts.include_usage === undefined) {
      outgoingBody.stream_options = { ...existingOpts, include_usage: true };
      didMutate = true;
    }
  }

  // Forward the exact raw bytes when unmodified so client SHA-256 TEE proofs match 1:1.
  const outboundBodyStr =
    !didMutate && rawBody !== undefined ? rawBody : JSON.stringify(outgoingBody);
  const upstreamRequestSha256 = crypto
    .createHash("sha256")
    .update(outboundBodyStr, "utf8")
    .digest("hex");

  const upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, endpointPath);
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.nearAiApiKey}`,
      },
      body: outboundBodyStr,
    });
  } catch (err) {
    ledger.settleReservation(session.sessionId, reservedUsd, 0, false);
    throw err;
  }

  if (!upstreamRes.ok) {
    ledger.settleReservation(session.sessionId, reservedUsd, 0, false);
    const errText = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(errText);
    return;
  }

  const estimatedInputTokens = estimatePromptTokens(bodyObj);

  if (!isStream || !upstreamRes.body) {
    const rawText = await upstreamRes.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const usage = (parsed?.usage || {}) as {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };

    const promptTokens =
      Number(usage.prompt_tokens ?? usage.input_tokens) || estimatedInputTokens;
    const completionTokens =
      Number(usage.completion_tokens ?? usage.output_tokens) ||
      Math.max(1, Math.ceil(rawText.length / 16));

    const costUsd = calculateTokenCostUsd(pricing, promptTokens, completionTokens);
    const updated = ledger.settleReservation(session.sessionId, reservedUsd, costUsd);

    const headers: Record<string, string> = {
      "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
      "X-Near402-Session": session.sessionId,
      "X-Near402-Request-Sha256": upstreamRequestSha256,
      "X-Near402-Cost-Usd": costUsd.toFixed(8),
      "X-Near402-Balance-Usd": (updated?.balanceUsd ?? 0).toFixed(8),
      "X-Near402-Prompt-Tokens": String(promptTokens),
      "X-Near402-Completion-Tokens": String(completionTokens),
    };
    if (typeof parsed?.id === "string") {
      headers["X-Near-Chat-Id"] = parsed.id;
    }

    res.writeHead(upstreamRes.status, headers);
    res.end(rawText);
    return;
  }

  // Streaming SSE mode: stream immediately while inspecting chunks for usage & chat id
  res.writeHead(200, {
    "Content-Type": upstreamRes.headers.get("content-type") || "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
    "X-Near402-Session": session.sessionId,
    "X-Near402-Request-Sha256": upstreamRequestSha256,
    "X-Near402-Balance-Usd-Before": session.balanceUsd.toFixed(8),
  });

  const decoder = new TextDecoder();
  let lineBuffer = "";
  let chatId: string | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let completionChars = 0;

  const inspectLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload) as {
        id?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        };
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
      };
      if (json.id && !chatId) chatId = json.id;
      if (json.usage) {
        const p = Number(json.usage.prompt_tokens ?? json.usage.input_tokens);
        const c = Number(json.usage.completion_tokens ?? json.usage.output_tokens);
        if (Number.isFinite(p) && p > 0) promptTokens = p;
        if (Number.isFinite(c) && c >= 0) completionTokens = c;
      }
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) completionChars += delta.content.length;
      if (delta?.reasoning_content) completionChars += delta.reasoning_content.length;
    } catch {
      // Ignore partial or non-JSON SSE lines
    }
  };

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        res.write(value);
        lineBuffer += decoder.decode(value, { stream: true });
        let nl = lineBuffer.indexOf("\n");
        while (nl !== -1) {
          const line = lineBuffer.slice(0, nl);
          lineBuffer = lineBuffer.slice(nl + 1);
          inspectLine(line);
          nl = lineBuffer.indexOf("\n");
        }
      }
    }
    if (lineBuffer.length > 0) {
      inspectLine(lineBuffer);
    }
  } finally {
    const finalPrompt = promptTokens > 0 ? promptTokens : estimatedInputTokens;
    const finalCompletion =
      completionTokens > 0
        ? completionTokens
        : Math.max(1, Math.ceil(completionChars / 4));
    const costUsd = calculateTokenCostUsd(pricing, finalPrompt, finalCompletion);
    ledger.settleReservation(session.sessionId, reservedUsd, costUsd);
    if (!res.writableEnded) {
      res.end();
    }
  }
}

export async function forwardGetPassthrough(params: {
  config: ProxyConfig;
  req: IncomingMessage;
  res: ServerResponse;
  upstreamPathWithQuery: string;
}): Promise<void> {
  const headers: Record<string, string> = {};
  if (params.config.nearAiApiKey) {
    headers.Authorization = `Bearer ${params.config.nearAiApiKey}`;
  }
  const upstreamRes = await fetch(
    buildUpstreamUrl(params.config.upstreamBaseUrl, params.upstreamPathWithQuery),
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    },
  );
  const text = await upstreamRes.text();
  params.res.writeHead(upstreamRes.status, {
    "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  params.res.end(text);
}
