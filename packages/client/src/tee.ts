import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface SignatureApiResponse {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
  signature_kind?: "provider_tee" | "gateway";
}

export interface AttestationReportResponse {
  signing_address?: string;
  gateway_attestation?: { signing_address?: string };
  model_attestations?: Array<{ signing_address?: string }>;
}

export interface VerifyChatProofOptions {
  proxyBaseUrl: string;
  chatId: string;
  model: string;
  requestBody?: string;
  responseBody?: string;
  upstreamRequestHash?: string;
  expectedSigningAddress?: string;
  fetchImpl?: typeof fetch;
}

export interface ChatProofResult {
  valid: boolean;
  signatureValid: boolean;
  payloadMatched: boolean | null;
  payloadSource?: "client_exact" | "proxy_normalized";
  attestationMatched: boolean | null;
  signatureKind: "provider_tee" | "gateway" | "unknown";
  recoveredAddress: string;
  signingAddress: string;
  attestedAddress?: string;
  attestedAddresses?: string[];
  requestHash?: string;
  responseHash?: string;
  text: string;
  reason?: string;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(sha256(bytes));
}

export function recoverEip191Address(text: string, signatureHex: string): string {
  const cleanHex = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  const sigBytes = hexToBytes(cleanHex);
  if (sigBytes.length !== 65) {
    throw new Error(`Expected 65-byte ECDSA signature, got ${sigBytes.length} bytes`);
  }

  const v = sigBytes[64];
  const recovery = v >= 27 ? (v - 27) & 1 : v & 1;

  // @noble/curves v2 recovered format: [recovery(1), r(32), s(32)]
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(sigBytes.subarray(0, 64), 1);

  const msgBytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix, 0);
  prefixed.set(msgBytes, prefix.length);

  const digest = keccak_256(prefixed);
  const compressedPub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const uncompressedPub = secp256k1.Point.fromBytes(compressedPub).toBytes(false);
  const addressBytes = keccak_256(uncompressedPub.subarray(1)).subarray(-20);
  return `0x${bytesToHex(addressBytes)}`;
}

function extractAttestedAddresses(
  att: AttestationReportResponse,
  signatureKind: ChatProofResult["signatureKind"],
): string[] {
  const gw = att.gateway_attestation?.signing_address;
  const models = (att.model_attestations ?? [])
    .map((m) => m.signing_address)
    .filter((a): a is string => Boolean(a));
  const legacy = att.signing_address;

  const candidates =
    signatureKind === "provider_tee"
      ? [...models, legacy]
      : signatureKind === "gateway"
        ? [gw, legacy]
        : [gw, ...models, legacy];

  const unique: string[] = [];
  for (const addr of candidates) {
    if (addr && !unique.some((u) => u.toLowerCase() === addr.toLowerCase())) {
      unique.push(addr);
    }
  }
  return unique;
}

export async function verifyChatProof(
  options: VerifyChatProofOptions,
): Promise<ChatProofResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.proxyBaseUrl.replace(/\/+$/, "");

  const sigUrl = `${baseUrl}/v1/signature/${encodeURIComponent(
    options.chatId,
  )}?model=${encodeURIComponent(options.model)}&signing_algo=ecdsa`;

  let sigRes: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    sigRes = await fetchFn(sigUrl);
    if (sigRes.status !== 404 || attempt === 2) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  if (!sigRes || !sigRes.ok) {
    throw new Error(
      `Failed to fetch chat signature (${sigRes?.status ?? 0}): ${
        sigRes ? await sigRes.text() : "no response"
      }`,
    );
  }
  const sig = (await sigRes.json()) as SignatureApiResponse;

  const recoveredAddress = recoverEip191Address(sig.text, sig.signature);
  const signatureValid =
    recoveredAddress.toLowerCase() === sig.signing_address.toLowerCase();

  const parts = sig.text.split(":");
  const signatureKind: ChatProofResult["signatureKind"] =
    sig.signature_kind ??
    (parts.length >= 3 ? "provider_tee" : parts.length === 2 ? "gateway" : "unknown");

  let attestedAddresses: string[] = options.expectedSigningAddress
    ? [options.expectedSigningAddress]
    : [];

  if (attestedAddresses.length === 0) {
    try {
      const attRes = await fetchFn(
        `${baseUrl}/v1/attestation/report?model=${encodeURIComponent(
          options.model,
        )}&signing_algo=ecdsa`,
      );
      if (attRes.ok) {
        const att = (await attRes.json()) as AttestationReportResponse;
        attestedAddresses = extractAttestedAddresses(att, signatureKind);
      }
    } catch {
      // Optional attestation lookup
    }
  }

  let requestHash: string | undefined;
  let responseHash: string | undefined;
  let payloadMatched: boolean | null = null;
  let payloadSource: ChatProofResult["payloadSource"];

  if (options.requestBody !== undefined && options.responseBody !== undefined) {
    requestHash = sha256Hex(options.requestBody);
    responseHash = sha256Hex(options.responseBody);
    if (
      sig.text === `${options.model}:${requestHash}:${responseHash}` ||
      sig.text === `${requestHash}:${responseHash}`
    ) {
      payloadMatched = true;
      payloadSource = "client_exact";
    } else if (
      options.upstreamRequestHash &&
      (sig.text === `${options.model}:${options.upstreamRequestHash}:${responseHash}` ||
        sig.text === `${options.upstreamRequestHash}:${responseHash}`)
    ) {
      payloadMatched = true;
      payloadSource = "proxy_normalized";
      requestHash = options.upstreamRequestHash;
    } else {
      payloadMatched = false;
    }
  }

  const matchedAttested = attestedAddresses.find(
    (addr) => addr.toLowerCase() === recoveredAddress.toLowerCase(),
  );
  const attestedAddress = matchedAttested ?? attestedAddresses[0];
  const attestationMatched =
    attestedAddresses.length > 0 ? Boolean(matchedAttested) : null;

  const valid =
    signatureValid && payloadMatched !== false && attestationMatched !== false;

  let reason: string | undefined;
  if (!signatureValid) {
    reason = `Recovered ${recoveredAddress} does not match signing_address ${sig.signing_address}`;
  } else if (payloadMatched === false) {
    reason = "Signed request/response SHA-256 hashes do not match payload bytes";
  } else if (attestationMatched === false) {
    reason = `Signer ${recoveredAddress} does not match attested address(es) ${attestedAddresses.join(", ")}`;
  }

  return {
    valid,
    signatureValid,
    payloadMatched,
    ...(payloadSource ? { payloadSource } : {}),
    attestationMatched,
    signatureKind,
    recoveredAddress,
    signingAddress: sig.signing_address,
    attestedAddress,
    ...(attestedAddresses.length > 0 ? { attestedAddresses } : {}),
    requestHash,
    responseHash,
    text: sig.text,
    ...(reason ? { reason } : {}),
  };
}
