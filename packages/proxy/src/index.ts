#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createProxyServer } from "./server.js";

function loadNearestEnvFile(): string | null {
  if (typeof process.loadEnvFile !== "function") return null;

  const candidates = new Set<string>([
    path.resolve(process.cwd(), ".env"),
    ...(process.env.INIT_CWD ? [path.resolve(process.env.INIT_CWD, ".env")] : []),
    path.resolve(import.meta.dirname, "../../.env"),
    path.resolve(import.meta.dirname, "../../../.env"),
  ]);

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      process.loadEnvFile(envPath);
      return envPath;
    } catch {
      // Ignore unreadable or malformed optional .env file
    }
  }
  return null;
}

const loadedEnvPath = loadNearestEnvFile();
const { server, config } = createProxyServer();

server.listen(config.port, config.host, () => {
  console.log(
    `[near402-proxy] listening on http://${config.host}:${config.port} (${config.nearNetwork})`,
  );
  if (loadedEnvPath) {
    console.log(`[near402-proxy] loaded env:     ${loadedEnvPath}`);
  }
  console.log(`[near402-proxy] seller account: ${config.sellerAccountId}`);
  console.log(`[near402-proxy] default model:  ${config.defaultModel}`);
  console.log(`[near402-proxy] free trial:     $${config.freeAllowanceUsd.toFixed(2)} USD`);
  console.log(`[near402-proxy] upstream:       ${config.upstreamBaseUrl}`);
  if (!config.nearAiApiKey) {
    console.warn(
      `[near402-proxy] WARNING: NEAR_AI_API_KEY is not set; 402 challenges work, upstream inference will return 503.`,
    );
  }
});

