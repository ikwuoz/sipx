import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairString,
  keyToImplicitAddress,
} from "near-api-js";
import { NearNetwork } from "@near402/protocol";

export type WalletKeyType =
  | "full_access"
  | "function_call"
  | "gas_key_full_access"
  | "gas_key_function_call";

export interface WalletKeyScope {
  ownerAccountId?: string;
  contractId?: string;
  methodNames?: string[];
  allowanceNear?: string;
  numNonces?: number;
}

export interface EncryptedSecretEnvelope {
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  kdfParams: {
    N: number;
    r: number;
    p: number;
    dkLen: number;
  };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface PlaintextWalletFile {
  version?: 1 | 2;
  encrypted?: false;
  network: NearNetwork;
  accountId: string;
  publicKey: string;
  privateKey: KeyPairString;
  keyType?: WalletKeyType;
  scope?: WalletKeyScope;
  createdAt: string;
}

export interface EncryptedWalletFile {
  version: 2;
  encrypted: true;
  network: NearNetwork;
  accountId: string;
  publicKey: string;
  keyType?: WalletKeyType;
  scope?: WalletKeyScope;
  crypto: EncryptedSecretEnvelope;
  createdAt: string;
}

export type StoredWalletFile = PlaintextWalletFile | EncryptedWalletFile;

export interface StoredWallet {
  network: NearNetwork;
  accountId: string;
  publicKey: string;
  privateKey: KeyPairString;
  encrypted?: boolean;
  keyType: WalletKeyType;
  scope?: WalletKeyScope;
  createdAt: string;
}

export interface WalletMetadata {
  network: NearNetwork;
  accountId: string;
  publicKey: string;
  encrypted: boolean;
  keyType: WalletKeyType;
  scope?: WalletKeyScope;
  createdAt: string;
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".near402");
}

export function defaultWalletPath(): string {
  return path.join(defaultConfigDir(), "wallet.json");
}

export interface ClientConfig {
  proxyUrl?: string;
  network?: NearNetwork;
  autoClaimTrial?: boolean;
}

export function defaultSessionsPath(): string {
  return path.join(defaultConfigDir(), "sessions.json");
}

export function defaultClientConfigPath(): string {
  return path.join(defaultConfigDir(), "config.json");
}

export function loadClientConfig(
  configPath = defaultClientConfigPath(),
): ClientConfig {
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as ClientConfig;
  } catch {
    return {};
  }
}

export function saveClientConfig(
  patch: ClientConfig,
  configPath = defaultClientConfigPath(),
): ClientConfig {
  const merged: ClientConfig = {
    ...loadClientConfig(configPath),
    ...patch,
  };
  if (merged.proxyUrl) {
    merged.proxyUrl = merged.proxyUrl.replace(/\/+$/, "");
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, configPath);
  return merged;
}

export function resolveProxyUrl(
  explicitUrl?: string,
  configPath = defaultClientConfigPath(),
): string {
  const candidate =
    explicitUrl ||
    process.env.NEAR402_PROXY_URL ||
    loadClientConfig(configPath).proxyUrl ||
    "http://localhost:4020";
  return candidate.replace(/\/+$/, "");
}

export function getDefaultRpcUrl(network: NearNetwork): string {
  return network === "testnet"
    ? "https://test.rpc.fastnear.com"
    : "https://free.rpc.fastnear.com";
}

export function encryptPrivateKey(
  privateKey: KeyPairString,
  passphrase: string,
): EncryptedSecretEnvelope {
  if (!passphrase) {
    throw new Error("Passphrase must not be empty");
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const derivedKey = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  derivedKey.fill(0);

  return {
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_KEYLEN },
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
  };
}

export function decryptPrivateKey(
  envelope: EncryptedSecretEnvelope,
  passphrase: string,
): KeyPairString {
  if (!passphrase) {
    throw new Error("Passphrase is required to decrypt wallet");
  }
  if (envelope.cipher !== "aes-256-gcm" || envelope.kdf !== "scrypt") {
    throw new Error(`Unsupported wallet encryption format: ${envelope.cipher}/${envelope.kdf}`);
  }
  const salt = Buffer.from(envelope.salt, "hex");
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "hex");

  const derivedKey = crypto.scryptSync(
    passphrase,
    salt,
    envelope.kdfParams?.dkLen ?? SCRYPT_KEYLEN,
    {
      N: envelope.kdfParams?.N ?? SCRYPT_N,
      r: envelope.kdfParams?.r ?? SCRYPT_R,
      p: envelope.kdfParams?.p ?? SCRYPT_P,
    },
  );

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    return decrypted as KeyPairString;
  } catch {
    throw new Error("Invalid wallet passphrase or corrupted encrypted wallet");
  } finally {
    derivedKey.fill(0);
  }
}

export function isEncryptedWalletFile(raw: StoredWalletFile): raw is EncryptedWalletFile {
  return Boolean((raw as EncryptedWalletFile).encrypted && (raw as EncryptedWalletFile).crypto);
}

export function readRawWalletFile(
  walletPath = defaultWalletPath(),
): StoredWalletFile | null {
  if (!fs.existsSync(walletPath)) return null;
  const raw = fs.readFileSync(walletPath, "utf8");
  return JSON.parse(raw) as StoredWalletFile;
}

export function loadWalletMeta(
  walletPath = defaultWalletPath(),
): WalletMetadata | null {
  const parsed = readRawWalletFile(walletPath);
  if (!parsed) return null;
  return {
    network: parsed.network,
    accountId: parsed.accountId,
    publicKey: parsed.publicKey,
    encrypted: isEncryptedWalletFile(parsed),
    keyType: parsed.keyType ?? "full_access",
    ...(parsed.scope ? { scope: parsed.scope } : {}),
    createdAt: parsed.createdAt,
  };
}

export function saveWalletRecord(params: {
  walletPath?: string;
  network: NearNetwork;
  accountId: string;
  publicKey: string;
  privateKey: KeyPairString;
  keyType?: WalletKeyType;
  scope?: WalletKeyScope;
  passphrase?: string;
  createdAt?: string;
}): StoredWalletFile {
  const walletPath = params.walletPath ?? defaultWalletPath();
  const createdAt = params.createdAt ?? new Date().toISOString();
  const keyType = params.keyType ?? "full_access";

  const record: StoredWalletFile = params.passphrase
    ? {
        version: 2,
        encrypted: true,
        network: params.network,
        accountId: params.accountId,
        publicKey: params.publicKey,
        keyType,
        ...(params.scope ? { scope: params.scope } : {}),
        crypto: encryptPrivateKey(params.privateKey, params.passphrase),
        createdAt,
      }
    : {
        version: 2,
        encrypted: false,
        network: params.network,
        accountId: params.accountId,
        publicKey: params.publicKey,
        privateKey: params.privateKey,
        keyType,
        ...(params.scope ? { scope: params.scope } : {}),
        createdAt,
      };

  fs.mkdirSync(path.dirname(walletPath), { recursive: true });
  const tmpPath = `${walletPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, walletPath);
  return record;
}

export function loadWallet(
  walletPathOrOpts?: string | { walletPath?: string; passphrase?: string },
): StoredWallet | null {
  const opts =
    typeof walletPathOrOpts === "string"
      ? { walletPath: walletPathOrOpts }
      : (walletPathOrOpts ?? {});
  const walletPath = opts.walletPath ?? defaultWalletPath();
  const parsed = readRawWalletFile(walletPath);
  if (!parsed) return null;

  const keyType = parsed.keyType ?? "full_access";
  if (isEncryptedWalletFile(parsed)) {
    const passphrase = opts.passphrase ?? process.env.NEAR402_WALLET_PASSPHRASE;
    if (!passphrase) {
      throw new Error(
        `Wallet at ${walletPath} is encrypted. Provide --passphrase or set NEAR402_WALLET_PASSPHRASE.`,
      );
    }
    const privateKey = decryptPrivateKey(parsed.crypto, passphrase);
    return {
      network: parsed.network,
      accountId: parsed.accountId,
      publicKey: parsed.publicKey,
      privateKey,
      encrypted: true,
      keyType,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      createdAt: parsed.createdAt,
    };
  }

  return {
    network: parsed.network,
    accountId: parsed.accountId,
    publicKey: parsed.publicKey,
    privateKey: parsed.privateKey,
    encrypted: false,
    keyType,
    ...(parsed.scope ? { scope: parsed.scope } : {}),
    createdAt: parsed.createdAt,
  };
}

export function loadOrCreateWallet(params?: {
  walletPath?: string;
  network?: NearNetwork;
  passphrase?: string;
}): { wallet: StoredWallet; created: boolean } {
  const walletPath = params?.walletPath ?? defaultWalletPath();
  const existing = loadWallet({ walletPath, passphrase: params?.passphrase });
  if (existing) {
    return { wallet: existing, created: false };
  }

  const network: NearNetwork = params?.network ?? "mainnet";
  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();
  const accountId = keyToImplicitAddress(keyPair.getPublicKey());
  const privateKey = keyPair.toString() as KeyPairString;
  const createdAt = new Date().toISOString();

  saveWalletRecord({
    walletPath,
    network,
    accountId,
    publicKey,
    privateKey,
    keyType: "full_access",
    passphrase: params?.passphrase,
    createdAt,
  });

  return {
    wallet: {
      network,
      accountId,
      publicKey,
      privateKey,
      encrypted: Boolean(params?.passphrase),
      keyType: "full_access",
      createdAt,
    },
    created: true,
  };
}

export function encryptExistingWallet(params: {
  walletPath?: string;
  currentPassphrase?: string;
  newPassphrase: string;
}): EncryptedWalletFile {
  const walletPath = params.walletPath ?? defaultWalletPath();
  const wallet = loadWallet({ walletPath, passphrase: params.currentPassphrase });
  if (!wallet) {
    throw new Error(`No wallet found at ${walletPath}. Run \`near402 init\` first.`);
  }
  const saved = saveWalletRecord({
    walletPath,
    network: wallet.network,
    accountId: wallet.accountId,
    publicKey: wallet.publicKey,
    privateKey: wallet.privateKey,
    keyType: wallet.keyType,
    scope: wallet.scope,
    passphrase: params.newPassphrase,
    createdAt: wallet.createdAt,
  });
  return saved as EncryptedWalletFile;
}

export function createNearAccount(params: {
  accountId: string;
  privateKey: KeyPairString;
  network?: NearNetwork;
  rpcUrl?: string;
}): Account {
  const network = params.network ?? "mainnet";
  const provider = new JsonRpcProvider({
    url: params.rpcUrl || getDefaultRpcUrl(network),
  });
  return new Account(params.accountId, provider, params.privateKey);
}

export function loadSessionTokens(
  sessionsPath = defaultSessionsPath(),
): Record<string, string> {
  try {
    if (!fs.existsSync(sessionsPath)) return {};
    return JSON.parse(fs.readFileSync(sessionsPath, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveSessionToken(
  proxyOrigin: string,
  token: string,
  sessionsPath = defaultSessionsPath(),
): void {
  const current = loadSessionTokens(sessionsPath);
  current[proxyOrigin] = token;
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  const tmpPath = `${sessionsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, sessionsPath);
}
