import { v7 as uuidv7 } from "uuid";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { AbuseReviewRepository, abuseSignalProjection, mapAbuseSignal, type AbuseSignalRow, type AbuseReviewWrite } from "./abuse-review.repository";
import type { AbuseSignal } from "@alterx/contracts";
import type { Pool } from "pg";

export interface AbuseFact {
  readonly tenantId: string;
  readonly signalType: AbuseSignal["signal_type"];
  readonly source: string;
  readonly score: number;
  readonly evidenceRef: string;
  readonly sourceFingerprint: string;
  readonly observedAt: Date;
}

interface CountFactRow {
  tenant_id: string;
  evidence_ref: string;
  signal_count: string;
  observed_at: Date;
}

interface MarketplaceFactRow {
  tenant_id: string;
  evidence_ref: string;
  verdict: string;
  findings_json: unknown;
  observed_at: Date;
}

@Injectable()
export class AbuseSignalRepository implements OnModuleDestroy {
  constructor(
    private readonly store: Pool,
    private readonly platformSource: Pool | undefined,
    private readonly marketplaceSource: Pool | undefined,
    private readonly closePoolsOnDestroy = false,
  ) {}

  async list(status?: AbuseSignal["status"]): Promise<AbuseSignal[]> {
    const result = await this.store.query<AbuseSignalRow>(
      abuseSignalProjection + ` WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.score DESC,s.observed_at DESC,s.id DESC`,
      [status ?? null],
    );
    return result.rows.map(mapAbuseSignal);
  }

  async collectFacts(): Promise<AbuseFact[]> {
    if (!this.platformSource || !this.marketplaceSource) {
      throw new AbuseSignalSourceUnavailableError();
    }
    const [billing, credentials, marketplace] = await Promise.all([
      this.platformSource.query<CountFactRow>(
        `SELECT tenant_id::text,
                max(provider_event_id) AS evidence_ref,
                count(*)::text AS signal_count,
                max(created_at) AS observed_at
         FROM billing_events
         WHERE type IN ('payment.failed', 'payment_failed')
           AND created_at >= clock_timestamp() - interval '1 hour'
         GROUP BY tenant_id
         HAVING count(*) >= 3`,
      ),
      this.platformSource.query<CountFactRow>(
        `SELECT tenant_id::text,
                max(id::text) AS evidence_ref,
                count(*)::text AS signal_count,
                max(used_at) AS observed_at
         FROM credential_use_audits
         WHERE used_at >= clock_timestamp() - interval '10 minutes'
         GROUP BY tenant_id, credential_id
         HAVING count(*) >= 20`,
      ),
      this.marketplaceSource.query<MarketplaceFactRow>(
        `SELECT tenant_id, id AS evidence_ref, verdict,
                findings_json, scanned_at AS observed_at
         FROM tool_scan_reports
         WHERE verdict IN ('blocked', 'findings')
           AND scanned_at >= clock_timestamp() - interval '24 hours'`,
      ),
    ]);
    return [
      ...billing.rows.map((row) => countFact(
        row,
        "payment_fraud",
        "platform.billing_events.payment_failed_1h",
        40,
        10,
      )),
      ...credentials.rows.map((row) => countFact(
        row,
        "credential_abuse",
        "platform.credential_use_audits.credential_10m",
        30,
        2,
      )),
      ...marketplace.rows.flatMap(marketplaceFact),
    ];
  }

  async upsertFacts(facts: readonly AbuseFact[]): Promise<number> {
    let changed = 0;
    for (const fact of facts) {
      const result = await this.store.query(
        `INSERT INTO abuse_signals
           (id, tenant_id, signal_type, source, score, evidence_ref,
            source_fingerprint, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (source_fingerprint) DO UPDATE SET
           score = EXCLUDED.score,
           observed_at = EXCLUDED.observed_at,
           updated_at = clock_timestamp()
         RETURNING id`,
        [
          `abs_${uuidv7()}`,
          fact.tenantId,
          fact.signalType,
          fact.source,
          fact.score,
          fact.evidenceRef,
          fact.sourceFingerprint,
          fact.observedAt,
        ],
      );
      changed += result.rowCount ?? 0;
    }
    return changed;
  }

  eligibleStaff() { return new AbuseReviewRepository(this.store).eligibleStaff(); }
  assign(id: string, target: string, reason: string, actor: string, write: AbuseReviewWrite) {
    return new AbuseReviewRepository(this.store).assign(id,target,reason,actor,write);
  }
  review(id: string, decision: "confirm" | "dismiss", reason: string, actor: string, write: AbuseReviewWrite) {
    return new AbuseReviewRepository(this.store).review(id,decision,reason,actor,write);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.closePoolsOnDestroy) return;
    await Promise.all([
      this.store.end(),
      this.platformSource?.end(),
      this.marketplaceSource?.end(),
    ]);
  }
}

function countFact(
  row: CountFactRow,
  signalType: AbuseFact["signalType"],
  source: string,
  baseScore: number,
  scorePerSignal: number,
): AbuseFact {
  const count = Number(row.signal_count);
  return {
    tenantId: row.tenant_id,
    signalType,
    source,
    score: Math.min(100, baseScore + count * scorePerSignal),
    evidenceRef: row.evidence_ref,
    sourceFingerprint: `${signalType}:${row.evidence_ref}`,
    observedAt: row.observed_at,
  };
}

function marketplaceFact(row: MarketplaceFactRow): AbuseFact[] {
  const severities = findings(row.findings_json);
  const score = row.verdict === "blocked" || severities.includes("critical")
    ? 100
    : severities.includes("high") ? 80 : 0;
  if (score === 0) return [];
  return [{
    tenantId: row.tenant_id,
    signalType: "marketplace_supply_chain",
    source: "marketplace.tool_scan_reports.blocking_finding_24h",
    score,
    evidenceRef: row.evidence_ref,
    sourceFingerprint: `marketplace_supply_chain:${row.evidence_ref}`,
    observedAt: row.observed_at,
  }];
}

function findings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const severity = (item as Record<string, unknown>).severity;
    return typeof severity === "string" ? [severity.toLowerCase()] : [];
  });
}

export class AbuseSignalSourceUnavailableError extends Error {
  constructor() {
    super("Operations source database bindings are not configured");
  }
}
