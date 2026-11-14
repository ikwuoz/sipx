import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NEAR402_TOKEN_PREFIX } from "@near402/protocol";

export interface SessionRecord {
  sessionId: string;
  balanceUsd: number;
  totalCreditedUsd: number;
  totalSpentUsd: number;
  requestsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssuedChallengeRecord {
  challengeId: string;
  model: string;
  expiresAt: string;
}

export interface IssuedQuoteRecord {
  depositAddress: string;
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  amountOut: string;
  createdAt: string;
}

interface PersistedLedger {
  sessions: Record<string, SessionRecord>;
  redeemedTxRefs: string[];
  quotes: Record<string, IssuedQuoteRecord>;
  trialIps: string[];
}

interface TokenPayload {
  sid: string;
  iat: number;
}

export class SessionLedger {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly redeemedTxRefs = new Set<string>();
  private readonly challenges = new Map<string, IssuedChallengeRecord>();
  private readonly quotes = new Map<string, IssuedQuoteRecord>();
  private readonly trialIps = new Set<string>();

  constructor(
    private readonly secret: string,
    private readonly ledgerPath: string,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.ledgerPath) return;
    try {
      if (!fs.existsSync(this.ledgerPath)) return;
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedLedger>;
      for (const [sid, rec] of Object.entries(parsed.sessions ?? {})) {
        this.sessions.set(sid, rec);
      }
      for (const txRef of parsed.redeemedTxRefs ?? []) {
        this.redeemedTxRefs.add(txRef);
      }
      for (const [addr, q] of Object.entries(parsed.quotes ?? {})) {
        this.quotes.set(addr, q);
      }
      for (const ip of parsed.trialIps ?? []) {
        this.trialIps.add(ip);
      }
    } catch {
      // Start clean if file is corrupt or unreadable
    }
  }

  private persist(): void {
    if (!this.ledgerPath) return;
    const dir = path.dirname(this.ledgerPath);
    fs.mkdirSync(dir, { recursive: true });
    const data: PersistedLedger = {
      sessions: Object.fromEntries(this.sessions.entries()),
      redeemedTxRefs: Array.from(this.redeemedTxRefs),
      quotes: Object.fromEntries(this.quotes.entries()),
      trialIps: Array.from(this.trialIps),
    };
    const tmp = `${this.ledgerPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.ledgerPath);
  }

  signToken(sessionId: string): string {
    const payload: TokenPayload = { sid: sessionId, iat: Date.now() };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const sig = crypto
      .createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    return `${NEAR402_TOKEN_PREFIX}${encoded}.${sig}`;
  }

  verifyToken(token: string): SessionRecord | null {
    if (!token.startsWith(NEAR402_TOKEN_PREFIX)) return null;
    const raw = token.slice(NEAR402_TOKEN_PREFIX.length);
    const dotIdx = raw.indexOf(".");
    if (dotIdx <= 0) return null;

    const encoded = raw.slice(0, dotIdx);
    const sig = raw.slice(dotIdx + 1);
    const expectedSig = crypto
      .createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as TokenPayload;
      if (!payload?.sid) return null;
      return this.sessions.get(payload.sid) ?? null;
    } catch {
      return null;
    }
  }

  recordChallenge(record: IssuedChallengeRecord): void {
    this.challenges.set(record.challengeId, record);
    // Keep memory bounded
    if (this.challenges.size > 5000) {
      const oldest = this.challenges.keys().next().value;
      if (oldest) this.challenges.delete(oldest);
    }
  }

  getChallenge(challengeId: string): IssuedChallengeRecord | undefined {
    return this.challenges.get(challengeId);
  }

  recordQuote(quote: IssuedQuoteRecord): void {
    this.quotes.set(quote.depositAddress, quote);
    this.persist();
  }

  getQuote(depositAddress: string): IssuedQuoteRecord | undefined {
    return this.quotes.get(depositAddress);
  }

  isTxRedeemed(txRef: string): boolean {
    return this.redeemedTxRefs.has(txRef);
  }

  creditPayment(params: {
    txRef: string;
    amountUsd: number;
    existingToken?: string;
  }): { session: SessionRecord; token: string } {
    if (this.redeemedTxRefs.has(params.txRef)) {
      throw new Error(`Payment reference already redeemed: ${params.txRef}`);
    }
    if (params.amountUsd <= 0) {
      throw new Error("Credited USD amount must be positive");
    }

    let session: SessionRecord | null = null;
    let token = params.existingToken || "";

    if (params.existingToken) {
      session = this.verifyToken(params.existingToken);
    }

    const now = new Date().toISOString();
    if (!session) {
      const sessionId = `ses_${crypto.randomBytes(12).toString("hex")}`;
      session = {
        sessionId,
        balanceUsd: 0,
        totalCreditedUsd: 0,
        totalSpentUsd: 0,
        requestsCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(sessionId, session);
      token = this.signToken(sessionId);
    }

    session.balanceUsd = Number((session.balanceUsd + params.amountUsd).toFixed(8));
    session.totalCreditedUsd = Number(
      (session.totalCreditedUsd + params.amountUsd).toFixed(8),
    );
    session.updatedAt = now;
    this.redeemedTxRefs.add(params.txRef);
    this.persist();

    return { session, token };
  }

  claimTrialAllowance(
    clientIp: string,
    amountUsd: number,
  ): { session: SessionRecord; token: string } | null {
    if (this.trialIps.has(clientIp)) return null;
    this.trialIps.add(clientIp);
    const now = new Date().toISOString();
    const sessionId = `ses_${crypto.randomBytes(12).toString("hex")}`;
    const session: SessionRecord = {
      sessionId,
      balanceUsd: Number(amountUsd.toFixed(8)),
      totalCreditedUsd: Number(amountUsd.toFixed(8)),
      totalSpentUsd: 0,
      requestsCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    const token = this.signToken(sessionId);
    this.persist();
    return { session, token };
  }

  deductUsage(sessionId: string, costUsd: number): SessionRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const boundedCost = Math.max(0, costUsd);
    session.balanceUsd = Math.max(
      0,
      Number((session.balanceUsd - boundedCost).toFixed(8)),
    );
    session.totalSpentUsd = Number(
      (session.totalSpentUsd + boundedCost).toFixed(8),
    );
    session.requestsCount += 1;
    session.updatedAt = new Date().toISOString();
    this.persist();
    return session;
  }

  /**
   * Atomically holds up to `amountUsd` for an in-flight request so concurrent
   * calls cannot overspend the session's remaining balance.
   */
  reserveBalance(sessionId: string, amountUsd: number): number {
    const session = this.sessions.get(sessionId);
    if (!session || amountUsd <= 0) return 0;
    const reserved = Math.min(session.balanceUsd, Number(amountUsd.toFixed(8)));
    if (reserved <= 0) return 0;
    session.balanceUsd = Math.max(
      0,
      Number((session.balanceUsd - reserved).toFixed(8)),
    );
    session.updatedAt = new Date().toISOString();
    this.persist();
    return reserved;
  }

  /**
   * Reconciles a previous reservation against actual token cost. Refunds any
   * unused reserve (or charges full reserve on upstream failure when cost is 0).
   */
  settleReservation(
    sessionId: string,
    reservedUsd: number,
    actualCostUsd: number,
    countRequest = true,
  ): SessionRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const boundedCost = Math.max(0, actualCostUsd);
    const netDelta = reservedUsd - boundedCost;
    session.balanceUsd = Math.max(
      0,
      Number((session.balanceUsd + netDelta).toFixed(8)),
    );
    session.totalSpentUsd = Number(
      (session.totalSpentUsd + boundedCost).toFixed(8),
    );
    if (countRequest && boundedCost > 0) {
      session.requestsCount += 1;
    }
    session.updatedAt = new Date().toISOString();
    this.persist();
    return session;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
}

