import http, { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { NEAR402_TOKEN_PREFIX } from "@near402/protocol";
import {
  claimTrialToken,
  createNear402Fetch,
  Near402FetchOptions,
} from "./fetch.js";
import { SpendPolicy } from "./guardrails.js";
import { loadSessionTokens, saveSessionToken } from "./wallet.js";

export interface LocalBridgeOptions
  extends Omit<Near402FetchOptions, "spendPolicy"> {
  proxyBaseUrl: string;
  host?: string;
  port?: number;
  spendPolicy?: SpendPolicy;
  autoClaimTrial?: boolean;
}

const PAID_POST_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
]);

function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
  });
  res.end(JSON.stringify(body));
}

function sanitizeForwardHeaders(reqHeaders: IncomingMessage["headers"]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(reqHeaders)) {
    if (!val) continue;
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "accept-encoding"
    ) {
      continue;
    }
    const joined = Array.isArray(val) ? val.join(", ") : val;
    if (lower === "authorization") {
      // Only forward caller Authorization if it already holds a signed near402_ token;
      // drop placeholder OpenAI API keys such as "Bearer near402" or "Bearer sk-...".
      if (!joined.includes(NEAR402_TOKEN_PREFIX)) continue;
    }
    headers[key] = joined;
  }
  return headers;
}

/**
 * Create a local OpenAI-compatible HTTP bridge (`http://127.0.0.1:4021/v1`)
 * that transparently injects NEAR 402 settlement, SpendGuardrail enforcement,
 * session token caching, and optional free-trial auto-claim for any harness
 * (`pi`, Codex, Cursor, Claude Code, Python OpenAI SDK, etc.).
 */
export function createLocalBridgeServer(options: LocalBridgeOptions): {
  server: http.Server;
  proxyOrigin: string;
} {
  const proxyOrigin = new URL(options.proxyBaseUrl).origin;
  const rawFetch = options.baseFetch ?? fetch;
  const fetch402 = createNear402Fetch({
    ...options,
    autoClaimTrial: options.autoClaimTrial ?? true,
    baseFetch: rawFetch,
  });

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

      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const pathname = url.pathname;
      const upstreamUrl = `${proxyOrigin}${pathname}${url.search}`;

      if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
        const healthRes = await rawFetch(`${proxyOrigin}/health`).catch(() => null);
        const upstream = healthRes?.ok ? await healthRes.json() : null;
        sendJson(res, 200, {
          service: "near402-local-bridge",
          proxyOrigin,
          autoClaimTrial: options.autoClaimTrial ?? true,
          upstream,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/402/balance") {
        const sessions = loadSessionTokens(options.sessionsPath);
        const token = sessions[proxyOrigin];
        if (!token) {
          sendJson(res, 200, { balanceUsd: 0, tokenCached: false, proxyOrigin });
          return;
        }
        const upstreamRes = await rawFetch(`${proxyOrigin}/v1/402/balance`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await upstreamRes.text();
        res.writeHead(upstreamRes.status, {
          "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(text);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/402/trial") {
        const trial = await claimTrialToken({ proxyBaseUrl: proxyOrigin, fetchImpl: rawFetch });
        if (!trial) {
          sendJson(res, 400, {
            error: { code: "trial_unavailable", message: "Trial unavailable or already claimed" },
          });
          return;
        }
        if (options.persistSessions ?? true) {
          saveSessionToken(proxyOrigin, trial.token, options.sessionsPath);
        }
        sendJson(res, 200, trial);
        return;
      }

      const isPaidPost = req.method === "POST" && PAID_POST_PATHS.has(pathname);
      const isPublicGet =
        req.method === "GET" &&
        (pathname === "/v1/models" ||
          pathname === "/v1/attestation/report" ||
          pathname.startsWith("/v1/signature/"));

      if (!isPaidPost && !isPublicGet) {
        sendJson(res, 404, {
          error: { code: "not_found", message: `Unsupported route: ${req.method} ${pathname}` },
        });
        return;
      }

      const forwardHeaders = sanitizeForwardHeaders(req.headers);
      const body = isPaidPost ? await readBodyBuffer(req) : undefined;
      if (isPaidPost && !forwardHeaders["content-type"] && !forwardHeaders["Content-Type"]) {
        forwardHeaders["Content-Type"] = "application/json";
      }

      const fetcher = isPaidPost ? fetch402 : rawFetch;
      const upstreamRes = await fetcher(upstreamUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      });

      const responseHeaders: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
      };
      const ct = upstreamRes.headers.get("content-type");
      if (ct) responseHeaders["Content-Type"] = ct;
      const cc = upstreamRes.headers.get("cache-control");
      if (cc) responseHeaders["Cache-Control"] = cc;

      res.writeHead(upstreamRes.status, responseHeaders);
      if (!upstreamRes.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstreamRes.body as unknown as import("node:stream/web").ReadableStream).pipe(
        res,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Local bridge error";
      if (!res.headersSent) {
        sendJson(res, 502, { error: { code: "bridge_error", message } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return { server, proxyOrigin };
}

export async function startLocalBridge(options: LocalBridgeOptions): Promise<{
  server: http.Server;
  url: string;
  proxyOrigin: string;
  close: () => Promise<void>;
}> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4021;
  const { server, proxyOrigin } = createLocalBridgeServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;
  return {
    server,
    url,
    proxyOrigin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
