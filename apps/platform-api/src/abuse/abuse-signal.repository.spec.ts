import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AbuseSignalRepository } from "./abuse-signal.repository";

describe("AbuseSignalRepository", () => {
  it("derives scores only from measured billing, credential, and scan facts", async () => {
    const platformQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
        evidence_ref: "evt_failed_4",
        signal_count: "4",
        observed_at: new Date("2026-08-06T10:00:00.000Z"),
      }] })
      .mockResolvedValueOnce({ rows: [{
        tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
        evidence_ref: "credential-audit-25",
        signal_count: "25",
        observed_at: new Date("2026-08-06T10:01:00.000Z"),
      }] });
    const marketplaceQuery = vi.fn().mockResolvedValue({ rows: [{
      tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
      evidence_ref: "scn_real_report",
      verdict: "findings",
      findings_json: [{ severity: "high", rule: "install-script" }],
      observed_at: new Date("2026-08-06T10:02:00.000Z"),
    }] });
    const repository = new AbuseSignalRepository(
      { query: vi.fn() } as unknown as Pool,
      { query: platformQuery } as unknown as Pool,
      { query: marketplaceQuery } as unknown as Pool,
    );

    await expect(repository.collectFacts()).resolves.toMatchObject([
      { signalType: "payment_fraud", score: 80, evidenceRef: "evt_failed_4" },
      { signalType: "credential_abuse", score: 80, evidenceRef: "credential-audit-25" },
      { signalType: "marketplace_supply_chain", score: 80, evidenceRef: "scn_real_report" },
    ]);
    expect(platformQuery.mock.calls[0]?.[0]).toContain("billing_events");
    expect(platformQuery.mock.calls[1]?.[0]).toContain("credential_use_audits");
    expect(marketplaceQuery.mock.calls[0]?.[0]).toContain("tool_scan_reports");
  });

  it("handles unavailable sources, score caps, and non-actionable scan findings", async () => {
    const unavailable = new AbuseSignalRepository({ query: vi.fn() } as unknown as Pool, undefined, undefined);
    await expect(unavailable.collectFacts()).rejects.toThrow("database bindings are not configured");

    const platformQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        tenant_id: "tenant-1",
        evidence_ref: "evt_failed_20",
        signal_count: "20",
        observed_at: new Date("2026-08-06T10:00:00.000Z"),
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const marketplaceQuery = vi.fn().mockResolvedValue({ rows: [
      {
        tenant_id: "tenant-1",
        evidence_ref: "scn_critical",
        verdict: "findings",
        findings_json: [{ severity: "CRITICAL" }, null, { severity: 5 }],
        observed_at: new Date("2026-08-06T10:00:00.000Z"),
      },
      {
        tenant_id: "tenant-1",
        evidence_ref: "scn_blocked",
        verdict: "blocked",
        findings_json: "not-an-array",
        observed_at: new Date("2026-08-06T10:00:00.000Z"),
      },
      {
        tenant_id: "tenant-1",
        evidence_ref: "scn_low",
        verdict: "findings",
        findings_json: [{ severity: "low" }],
        observed_at: new Date("2026-08-06T10:00:00.000Z"),
      },
    ] });
    const repository = new AbuseSignalRepository(
      { query: vi.fn() } as unknown as Pool,
      { query: platformQuery } as unknown as Pool,
      { query: marketplaceQuery } as unknown as Pool,
    );

    await expect(repository.collectFacts()).resolves.toMatchObject([
      { signalType: "payment_fraud", score: 100 },
      { evidenceRef: "scn_critical", score: 100 },
      { evidenceRef: "scn_blocked", score: 100 },
    ]);
  });

  it("lists, writes, and closes only pools it owns", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "abs_018f47a5-7b2c-7d10-8f11-123456789abc",
        tenant_id: "tenant-1",
        signal_type: "payment_fraud",
        source: "billing",
        score: "40",
        evidence_ref: "evt-1",
        observed_at: new Date("2026-08-06T10:00:00.000Z"),
        status: "open", revision: "1", assigned_to: null,
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const store = { query, end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const platform = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const marketplace = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const repository = new AbuseSignalRepository(store, platform, marketplace, true);
    const facts = [{
      tenantId: "tenant-1",
      signalType: "payment_fraud" as const,
      source: "billing",
      score: 40,
      evidenceRef: "evt-1",
      sourceFingerprint: "payment_fraud:evt-1",
      observedAt: new Date("2026-08-06T10:00:00.000Z"),
    }, {
      tenantId: "tenant-1",
      signalType: "credential_abuse" as const,
      source: "credentials",
      score: 80,
      evidenceRef: "audit-1",
      sourceFingerprint: "credential_abuse:audit-1",
      observedAt: new Date("2026-08-06T10:00:00.000Z"),
    }];

    await expect(repository.list("open")).resolves.toMatchObject([{ score: 40, status: "open" }]);
    await expect(repository.upsertFacts(facts)).resolves.toBe(1);
    await repository.onModuleDestroy();
    expect(query.mock.calls[0]?.[1]).toEqual(["open"]);
    expect((store.end as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((platform.end as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((marketplace.end as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();

    await new AbuseSignalRepository(store, undefined, undefined).onModuleDestroy();
  });
});
