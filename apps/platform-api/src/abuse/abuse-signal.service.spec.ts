import { describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../admin-audit";
import {
  AbuseSignalRepository,
  AbuseSignalSourceUnavailableError,
} from "./abuse-signal.repository";
import { AbuseSignalService } from "./abuse-signal.service";
import { AbuseSignalsHttpError } from "./problem";

describe("AbuseSignalService", () => {
  it("stores real observations and audits review decisions", async () => {
    const fact = {
      tenantId: "f0204070-2fd2-4bb7-a117-3222301822fe",
      signalType: "payment_fraud" as const,
      source: "platform.billing_events.payment_failed_1h",
      score: 80,
      evidenceRef: "evt_failed_4",
      sourceFingerprint: "payment_fraud:evt_failed_4",
      observedAt: new Date("2026-08-06T10:00:00.000Z"),
    };
    const signal = {
      id: "abs_018f47a5-7b2c-7d10-8f11-123456789abc",
      tenant_id: fact.tenantId,
      signal_type: fact.signalType,
      source: fact.source,
      score: fact.score,
      evidence_ref: fact.evidenceRef,
      observed_at: fact.observedAt.toISOString(),
      status: "confirmed" as const,
    };
    const collectFacts = vi.fn().mockResolvedValue([fact]);
    const upsertFacts = vi.fn().mockResolvedValue(1);
    const review = vi.fn(async (_id, _decision, _reason, _actor, write) => { await write.audit(signal, "asa_actual-history"); return signal; });
    const record = vi.fn().mockResolvedValue("a".repeat(64));
    const service = new AbuseSignalService(
      { collectFacts, upsertFacts, review } as unknown as AbuseSignalRepository,
      { record } as unknown as AdminAuditService,
    );

    await expect(service.refresh("stf_security")).resolves.toEqual({
      observed: 1,
      stored: 1,
    });
    await expect(service.review(signal.id, "stf_security", {
      decision: "confirm",
      reason: "provider evidence verified",
    })).resolves.toEqual(signal);
    expect(upsertFacts).toHaveBeenCalledWith([fact]);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "abuse.signal.confirm",
      tenantId: fact.tenantId,
    }));
  });

  it("keeps source failures explicit and rejects duplicate reviews", async () => {
    const unavailable = new AbuseSignalService(
      {
        collectFacts: vi.fn().mockRejectedValue(new AbuseSignalSourceUnavailableError()),
        upsertFacts: vi.fn(),
        review: vi.fn().mockResolvedValue(undefined),
      } as unknown as AbuseSignalRepository,
      { record: vi.fn() } as unknown as AdminAuditService,
    );

    await expect(unavailable.refresh("stf_security")).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ error_code: "ABUSE_SIGNAL_SOURCES_UNAVAILABLE" }),
    });
    await expect(unavailable.review("abs_018f47a5-7b2c-7d10-8f11-123456789abc", "stf_security", {
      decision: "dismiss",
      reason: "already handled",
    })).rejects.toBeInstanceOf(AbuseSignalsHttpError);

    const sourceFailure = new Error("database credentials invalid");
    const unexpected = new AbuseSignalService(
      {
        collectFacts: vi.fn().mockRejectedValue(sourceFailure),
        upsertFacts: vi.fn(),
        review: vi.fn(),
      } as unknown as AbuseSignalRepository,
      { record: vi.fn() } as unknown as AdminAuditService,
    );
    await expect(unexpected.refresh("stf_security")).rejects.toBe(sourceFailure);
  });

  it("lists the requested signal status", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const service = new AbuseSignalService(
      { list } as unknown as AbuseSignalRepository,
      {} as AdminAuditService,
    );

    await expect(service.list()).resolves.toEqual([]);
    await expect(service.list("dismissed")).resolves.toEqual([]);
    expect(list).toHaveBeenNthCalledWith(1, undefined);
    expect(list).toHaveBeenNthCalledWith(2, "dismissed");
  });
});
