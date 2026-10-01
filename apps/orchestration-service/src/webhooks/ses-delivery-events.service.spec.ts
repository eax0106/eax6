import { describe, expect, it, vi } from "vitest";
import { parseSesDeliveryEvent, SesDeliveryEventsService } from "./ses-delivery-events.service";

const TENANT = "ten_00000000-0000-7000-8000-000000000001";

describe("SES delivery read-back", () => {
  it("parses SNS bounce tags and rejects events without tenant identity", () => {
    expect(parseSesDeliveryEvent({
      Type: "Notification",
      Message: JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "ses-1", tags: { alter_tenant_id: [TENANT] } },
        bounce: { bounceType: "Permanent" },
      }),
    })).toEqual({ type: "Bounce", messageId: "ses-1", tenantId: TENANT, reason: "Permanent" });
    expect(() => parseSesDeliveryEvent({ eventType: "Bounce", mail: { messageId: "ses-1" } })).toThrow();
  });

  it("marks a bounce once and appends a failed run status", async () => {
    const markEmailDeliveryFailed = vi.fn(async () => ({ runId: "run_00000000-0000-7000-8000-000000000001" }));
    const append = vi.fn(async () => undefined);
    const service = new SesDeliveryEventsService(
      { markEmailDeliveryFailed } as never,
      { append } as never,
    );
    await expect(service.handle({ type: "Bounce", messageId: "ses-1", tenantId: TENANT, reason: "Permanent" })).resolves.toEqual({ matched: true });
    expect(markEmailDeliveryFailed).toHaveBeenCalledWith(TENANT, "ses-1", "Permanent");
    expect(append).toHaveBeenCalledWith(TENANT, "run_00000000-0000-7000-8000-000000000001", {
      event: "run.status",
      data: { status: "failed", reason: "Email delivery failed" },
    });
  });

  it("does not mutate the ledger for delivery notifications", async () => {
    const markEmailDeliveryFailed = vi.fn();
    const service = new SesDeliveryEventsService({ markEmailDeliveryFailed } as never, { append: vi.fn() } as never);
    await expect(service.handle({ type: "Delivery", messageId: "ses-1", tenantId: TENANT })).resolves.toEqual({ matched: false });
    expect(markEmailDeliveryFailed).not.toHaveBeenCalled();
  });
});
