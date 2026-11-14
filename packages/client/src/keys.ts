import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairString,
  PublicKey,
} from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import { NEAR_USDC_CONTRACT_MAINNET, NearNetwork } from "@near402/protocol";
import {
  defaultWalletPath,
  getDefaultRpcUrl,
  saveWalletRecord,
  WalletKeyScope,
  WalletKeyType,
} from "./wallet.js";

export type ProvisionAgentKeyMode =
  | "gas_key_full"
  | "gas_key_function_call"
  | "function_call";

export interface ProvisionAgentKeyOptions {
  ownerAccount: Account;
  network?: NearNetwork;
  mode: ProvisionAgentKeyMode;
  /** Target contract for function_call / gas_key_function_call (defaults to mainnet USDC). */
  contractId?: string;
  /** Allowed contract methods (defaults to ["ft_transfer", "storage_deposit"] when contractId is USDC). */
  methodNames?: string[];
  /** Gas allowance in NEAR for classic FunctionCall keys (default "0.25"). */
  allowanceNear?: string;
  /** Initial NEAR balance to fund into a Gas Key (default "0.05", "0" skips funding). */
  gasDepositNear?: string;
  /** Number of independent nonce lanes for Gas Keys (1-1024, default 4). */
  numNonces?: number;
  /** Persist the newly generated child key into wallet.json. */
  saveToWallet?: boolean;
  walletPath?: string;
  /** Encrypt privateKey in wallet.json with AES-256-GCM + scrypt when saving. */
  passphrase?: string;
}

export interface ProvisionedAgentKeyResult {
  accountId: string;
  publicKey: string;
  privateKey: KeyPairString;
  keyType: WalletKeyType;
  scope: WalletKeyScope;
  txHashes: string[];
  walletPath?: string;
}

export interface InspectedKeyStatus {
  accountId: string;
  publicKey: string;
  keyType: WalletKeyType;
  nonce: string;
  contractId?: string;
  methodNames?: string[];
  allowanceNear?: string | null;
  gasBalanceNear?: string;
  numNonces?: number;
  nonceLanes?: string[];
}

function extractTxHash(res: unknown): string | undefined {
  const r = res as {
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
  };
  return r?.transaction?.hash || r?.transaction_outcome?.id;
}

export async function provisionAgentKey(
  options: ProvisionAgentKeyOptions,
): Promise<ProvisionedAgentKeyResult> {
  const { ownerAccount, mode } = options;
  const network = options.network ?? "mainnet";
  const child = KeyPair.fromRandom("ed25519");
  const publicKey = child.getPublicKey().toString();
  const privateKey = child.toString() as KeyPairString;

  const contractId = options.contractId ?? NEAR_USDC_CONTRACT_MAINNET;
  const methodNames =
    options.methodNames ??
    (contractId === NEAR_USDC_CONTRACT_MAINNET
      ? ["ft_transfer", "storage_deposit"]
      : []);

  const txHashes: string[] = [];
  let keyType: WalletKeyType;
  let scope: WalletKeyScope;

  if (mode === "gas_key_full") {
    keyType = "gas_key_full_access";
    const numNonces = Math.max(1, Math.min(1024, Math.floor(options.numNonces ?? 4)));
    const addRes = await ownerAccount.addFullAccessGasKey(publicKey, numNonces);
    const addHash = extractTxHash(addRes);
    if (addHash) txHashes.push(addHash);

    const depositStr = options.gasDepositNear ?? "0.05";
    const depositYocto = NEAR.toUnits(depositStr);
    if (depositYocto > 0n) {
      const fundRes = await ownerAccount.transferToGasKey(
        ownerAccount.accountId,
        publicKey,
        depositYocto,
      );
      const fundHash = extractTxHash(fundRes);
      if (fundHash) txHashes.push(fundHash);
    }

    scope = {
      ownerAccountId: ownerAccount.accountId,
      numNonces,
      allowanceNear: depositStr,
    };
  } else if (mode === "gas_key_function_call") {
    keyType = "gas_key_function_call";
    const numNonces = Math.max(1, Math.min(1024, Math.floor(options.numNonces ?? 4)));
    const addRes = await ownerAccount.addFunctionCallGasKey({
      publicKey,
      contractId,
      methodNames,
      numNonces,
    });
    const addHash = extractTxHash(addRes);
    if (addHash) txHashes.push(addHash);

    const depositStr = options.gasDepositNear ?? "0.05";
    const depositYocto = NEAR.toUnits(depositStr);
    if (depositYocto > 0n) {
      const fundRes = await ownerAccount.transferToGasKey(
        ownerAccount.accountId,
        publicKey,
        depositYocto,
      );
      const fundHash = extractTxHash(fundRes);
      if (fundHash) txHashes.push(fundHash);
    }

    scope = {
      ownerAccountId: ownerAccount.accountId,
      contractId,
      methodNames,
      numNonces,
      allowanceNear: depositStr,
    };
  } else {
    keyType = "function_call";
    const allowanceNear = options.allowanceNear ?? "0.25";
    const allowanceYocto = NEAR.toUnits(allowanceNear);
    const addRes = await ownerAccount.addFunctionCallAccessKey({
      publicKey,
      contractId,
      methodNames,
      allowance: allowanceYocto,
    });
    const addHash = extractTxHash(addRes);
    if (addHash) txHashes.push(addHash);

    scope = {
      ownerAccountId: ownerAccount.accountId,
      contractId,
      methodNames,
      allowanceNear,
    };
  }

  let savedPath: string | undefined;
  if (options.saveToWallet) {
    savedPath = options.walletPath ?? defaultWalletPath();
    saveWalletRecord({
      walletPath: savedPath,
      network,
      accountId: ownerAccount.accountId,
      publicKey,
      privateKey,
      keyType,
      scope,
      passphrase: options.passphrase,
    });
  }

  return {
    accountId: ownerAccount.accountId,
    publicKey,
    privateKey,
    keyType,
    scope,
    txHashes,
    ...(savedPath ? { walletPath: savedPath } : {}),
  };
}

export async function inspectAgentKey(params: {
  accountId: string;
  publicKey: string | PublicKey;
  network?: NearNetwork;
  rpcUrl?: string;
}): Promise<InspectedKeyStatus> {
  const network = params.network ?? "mainnet";
  const provider = new JsonRpcProvider({
    url: params.rpcUrl || getDefaultRpcUrl(network),
  });
  const pkStr =
    typeof params.publicKey === "string" ? params.publicKey : params.publicKey.toString();

  const view = await provider.viewAccessKey({
    accountId: params.accountId,
    publicKey: pkStr,
    finalityQuery: { finality: "final" },
  });

  const perm = view.permission;
  const nonceStr = String(view.nonce);

  if (perm === "FullAccess") {
    return {
      accountId: params.accountId,
      publicKey: pkStr,
      keyType: "full_access",
      nonce: nonceStr,
    };
  }

  if ("FunctionCall" in perm) {
    return {
      accountId: params.accountId,
      publicKey: pkStr,
      keyType: "function_call",
      nonce: nonceStr,
      contractId: perm.FunctionCall.receiver_id,
      methodNames: perm.FunctionCall.method_names,
      allowanceNear: perm.FunctionCall.allowance
        ? NEAR.toDecimal(BigInt(perm.FunctionCall.allowance), 6)
        : null,
    };
  }

  if ("GasKeyFullAccess" in perm) {
    let nonceLanes: string[] | undefined;
    try {
      const lanes = await provider.viewGasKeyNonces({
        accountId: params.accountId,
        publicKey: pkStr,
      });
      nonceLanes = lanes.nonces.map((n) => String(n));
    } catch {
      // Optional on RPC nodes before gas key nonces query support
    }
    return {
      accountId: params.accountId,
      publicKey: pkStr,
      keyType: "gas_key_full_access",
      nonce: nonceStr,
      gasBalanceNear: NEAR.toDecimal(BigInt(perm.GasKeyFullAccess.balance), 6),
      numNonces: perm.GasKeyFullAccess.num_nonces,
      nonceLanes,
    };
  }

  if ("GasKeyFunctionCall" in perm) {
    let nonceLanes: string[] | undefined;
    try {
      const lanes = await provider.viewGasKeyNonces({
        accountId: params.accountId,
        publicKey: pkStr,
      });
      nonceLanes = lanes.nonces.map((n) => String(n));
    } catch {
      // Optional
    }
    return {
      accountId: params.accountId,
      publicKey: pkStr,
      keyType: "gas_key_function_call",
      nonce: nonceStr,
      contractId: perm.GasKeyFunctionCall.receiver_id,
      methodNames: perm.GasKeyFunctionCall.method_names,
      allowanceNear: perm.GasKeyFunctionCall.allowance
        ? NEAR.toDecimal(BigInt(perm.GasKeyFunctionCall.allowance), 6)
        : null,
      gasBalanceNear: NEAR.toDecimal(BigInt(perm.GasKeyFunctionCall.balance), 6),
      numNonces: perm.GasKeyFunctionCall.num_nonces,
      nonceLanes,
    };
  }

  return {
    accountId: params.accountId,
    publicKey: pkStr,
    keyType: "full_access",
    nonce: nonceStr,
  };
}

export async function fundGasKey(params: {
  account: Account;
  ownerAccountId?: string;
  publicKey: string;
  amountNear: string;
}): Promise<string | undefined> {
  const res = await params.account.transferToGasKey(
    params.ownerAccountId ?? params.account.accountId,
    params.publicKey,
    NEAR.toUnits(params.amountNear),
  );
  return extractTxHash(res);
}

export async function revokeAgentKey(params: {
  ownerAccount: Account;
  publicKey: string;
}): Promise<string | undefined> {
  const res = await params.ownerAccount.deleteKey(params.publicKey);
  return extractTxHash(res);
}
