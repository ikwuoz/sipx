import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SpendPolicy {
  /** Maximum USD allowed for a single 402 payment/top-up. */
  maxPerPaymentUsd?: number;
  /** Maximum cumulative USD allowed over a rolling 1-hour window. */
  maxHourlyUsd?: number;
  /** Maximum cumulative USD allowed over a rolling 24-hour window. */
  maxDailyUsd?: number;
  /** Maximum cumulative lifetime USD tracked in the spend ledger. */
  maxTotalUsd?: number;
  /** Optional allowlist of permitted seller NEAR account IDs. */
  allowedRecipients?: string[];
  /** Optional allowlist of permitted proxy origins (e.g. "https://api.example.com"). */
  allowedOrigins?: string[];
  /** Override path for persisted spend history; pass "" for in-memory only. */
  ledgerPath?: string;
}

export interface SpendRecord {
  timestamp: string;
  origin: string;
  recipientAccountId: string;
  amountUsd: number;
  txRef?: string;
  rail?: string;
}

interface PersistedSpendLedger {
  totalSpentUsd: number;
  entries: SpendRecord[];
}

export type SpendGuardrailViolationCode =
  | "origin_not_allowed"
  | "recipient_not_allowed"
  | "invalid_amount"
  | "per_payment_limit"
  | "hourly_limit"
  | "daily_limit"
  | "total_limit";

export class SpendGuardrailError extends Error {
  readonly code: SpendGuardrailViolationCode;

  constructor(code: SpendGuardrailViolationCode, message: string) {
    super(message);
    this.name = "SpendGuardrailError";
    this.code = code;
  }
}

export function defaultSpendLedgerPath(): string {
  return path.join(os.homedir(), ".near402", "spend-ledger.json");
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export class SpendGuardrail {
  private readonly policy: SpendPolicy;
  private readonly ledgerPath: string | null;
  private state: PersistedSpendLedger;

  constructor(policy: SpendPolicy = {}, persistDefault = true) {
    this.policy = policy;
    if (policy.ledgerPath === "") {
      this.ledgerPath = null;
    } else if (policy.ledgerPath) {
      this.ledgerPath = policy.ledgerPath;
    } else {
      this.ledgerPath = persistDefault ? defaultSpendLedgerPath() : null;
    }
    this.state = this.load();
  }

  private load(): PersistedSpendLedger {
    if (!this.ledgerPath || !fs.existsSync(this.ledgerPath)) {
      return { totalSpentUsd: 0, entries: [] };
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.ledgerPath, "utf8"),
      ) as Partial<PersistedSpendLedger>;
      return {
        totalSpentUsd: Number(parsed.totalSpentUsd) || 0,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      return { totalSpentUsd: 0, entries: [] };
    }
  }

  private save(nowMs = Date.now()): void {
    if (!this.ledgerPath) return;
    const cutoff = nowMs - ONE_DAY_MS;
    const pruned = this.state.entries.filter((e) => {
      const ts = Date.parse(e.timestamp);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    const toPersist: PersistedSpendLedger = {
      totalSpentUsd: Number(this.state.totalSpentUsd.toFixed(8)),
      entries: pruned,
    };
    this.state = toPersist;
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const tmpPath = `${this.ledgerPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(toPersist, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.ledgerPath);
  }

  getSummary(nowMs = Date.now()): {
    hourlyUsd: number;
    dailyUsd: number;
    totalSpentUsd: number;
    entriesCount24h: number;
    entries: SpendRecord[];
  } {
    // Re-read from disk when persisted so multi-process agents share limits
    if (this.ledgerPath) {
      this.state = this.load();
    }
    let hourlyUsd = 0;
    let dailyUsd = 0;
    const recent: SpendRecord[] = [];
    for (const entry of this.state.entries) {
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts)) continue;
      const age = nowMs - ts;
      if (age <= ONE_DAY_MS) {
        dailyUsd += entry.amountUsd;
        recent.push(entry);
        if (age <= ONE_HOUR_MS) {
          hourlyUsd += entry.amountUsd;
        }
      }
    }
    return {
      hourlyUsd: Number(hourlyUsd.toFixed(8)),
      dailyUsd: Number(dailyUsd.toFixed(8)),
      totalSpentUsd: Number(this.state.totalSpentUsd.toFixed(8)),
      entriesCount24h: recent.length,
      entries: recent,
    };
  }

  assertAllowed(params: {
    origin: string;
    recipientAccountId: string;
    amountUsd: number;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    const { origin, recipientAccountId, amountUsd } = params;

    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new SpendGuardrailError(
        "invalid_amount",
        `Refusing non-positive or invalid payment amount: ${amountUsd}`,
      );
    }

    if (this.policy.allowedOrigins && this.policy.allowedOrigins.length > 0) {
      const normalized = new URL(origin).origin;
      const allowed = this.policy.allowedOrigins.some(
        (o) => new URL(o).origin === normalized,
      );
      if (!allowed) {
        throw new SpendGuardrailError(
          "origin_not_allowed",
          `Origin ${normalized} is not in spendPolicy.allowedOrigins`,
        );
      }
    }

    if (
      this.policy.allowedRecipients &&
      this.policy.allowedRecipients.length > 0 &&
      !this.policy.allowedRecipients.includes(recipientAccountId)
    ) {
      throw new SpendGuardrailError(
        "recipient_not_allowed",
        `Seller recipient "${recipientAccountId}" is not in spendPolicy.allowedRecipients`,
      );
    }

    if (
      this.policy.maxPerPaymentUsd !== undefined &&
      amountUsd > this.policy.maxPerPaymentUsd + 1e-12
    ) {
      throw new SpendGuardrailError(
        "per_payment_limit",
        `Requested payment $${amountUsd.toFixed(4)} exceeds maxPerPaymentUsd ($${this.policy.maxPerPaymentUsd.toFixed(4)})`,
      );
    }

    const summary = this.getSummary(nowMs);

    if (
      this.policy.maxHourlyUsd !== undefined &&
      summary.hourlyUsd + amountUsd > this.policy.maxHourlyUsd + 1e-12
    ) {
      throw new SpendGuardrailError(
        "hourly_limit",
        `Payment of $${amountUsd.toFixed(4)} would bring 1h spend to $${(
          summary.hourlyUsd + amountUsd
        ).toFixed(4)}, exceeding maxHourlyUsd ($${this.policy.maxHourlyUsd.toFixed(4)})`,
      );
    }

    if (
      this.policy.maxDailyUsd !== undefined &&
      summary.dailyUsd + amountUsd > this.policy.maxDailyUsd + 1e-12
    ) {
      throw new SpendGuardrailError(
        "daily_limit",
        `Payment of $${amountUsd.toFixed(4)} would bring 24h spend to $${(
          summary.dailyUsd + amountUsd
        ).toFixed(4)}, exceeding maxDailyUsd ($${this.policy.maxDailyUsd.toFixed(4)})`,
      );
    }

    if (
      this.policy.maxTotalUsd !== undefined &&
      summary.totalSpentUsd + amountUsd > this.policy.maxTotalUsd + 1e-12
    ) {
      throw new SpendGuardrailError(
        "total_limit",
        `Payment of $${amountUsd.toFixed(4)} would bring total spend to $${(
          summary.totalSpentUsd + amountUsd
        ).toFixed(4)}, exceeding maxTotalUsd ($${this.policy.maxTotalUsd.toFixed(4)})`,
      );
    }
  }

  recordSpend(record: Omit<SpendRecord, "timestamp"> & { timestamp?: string }): void {
    const nowMs = record.timestamp ? Date.parse(record.timestamp) : Date.now();
    if (this.ledgerPath) {
      this.state = this.load();
    }
    this.state.entries.push({
      ...record,
      timestamp: record.timestamp ?? new Date(nowMs).toISOString(),
    });
    this.state.totalSpentUsd = Number(
      (this.state.totalSpentUsd + record.amountUsd).toFixed(8),
    );
    this.save(nowMs);
  }
}
