import { createMockBillingProvider, type BillingProvider } from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../admin-audit";
import { AdminBillingRepository } from "./admin-billing.repository";
import { AdminBillingService } from "./admin-billing.service";
import { BillingHttpError } from "./problem";

describe("AdminBillingService", () => {
  it("executes a provider refund then records central audit", async () => {
    const base = createMockBillingProvider();
    const refund = vi.fn(base.refundPayment.bind(base));
    const provider: BillingProvider = { ...base, refundPayment: refund };
    const record = vi.fn().mockResolvedValue("a".repeat(64));
    const service = new AdminBillingService(
      provider,
      { record } as unknown as AdminAuditService,
      {} as AdminBillingRepository,
    );

    await expect(service.refund("stf_billing", {
      payment_ref: "pay_123",
      amount_minor: 2_500,
      speed: "normal",
      reason: "duplicate charge",
    })).resolves.toMatchObject({ paymentRef: "pay_123", amount: 2_500 });
    expect(refund).toHaveBeenCalledWith("pay_123", 2_500, "normal", "duplicate charge");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      actorRef: "stf_billing",
      action: "billing.payment.refund",
      targetRef: "pay_123",
    }));
  });

  it("submits dispute resolution and records chosen action", async () => {
    const base = createMockBillingProvider();
    const resolve = vi.fn(base.resolveDispute.bind(base));
    const provider: BillingProvider = { ...base, resolveDispute: resolve };
    const record = vi.fn().mockResolvedValue("a".repeat(64));
    const service = new AdminBillingService(
      provider,
      { record } as unknown as AdminAuditService,
      {} as AdminBillingRepository,
    );

    await service.resolveDispute("stf_billing", "disp_123", {
      action: "contest",
      reason: "service delivered",
      evidence_refs: ["doc_123"],
    });
    expect(resolve).toHaveBeenCalledWith("disp_123", {
      action: "contest",
      reason: "service delivered",
      evidenceRefs: ["doc_123"],
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: "billing.dispute.contest",
      targetRef: "disp_123",
    }));
  });

  it("does not audit a rejected provider operation as successful", async () => {
    const base = createMockBillingProvider();
    const provider: BillingProvider = {
      ...base,
      refundPayment: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    const record = vi.fn();
    const service = new AdminBillingService(
      provider,
      { record } as unknown as AdminAuditService,
      {} as AdminBillingRepository,
    );

    await expect(service.refund("stf_billing", {
      payment_ref: "pay_123",
      amount_minor: 2_500,
      speed: "normal",
      reason: "duplicate charge",
    })).rejects.toBeInstanceOf(BillingHttpError);
    expect(record).not.toHaveBeenCalled();
  });
});
