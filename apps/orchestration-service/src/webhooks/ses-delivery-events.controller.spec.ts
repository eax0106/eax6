import { describe, expect, it, vi } from "vitest";
import { EmailDeliveryFailuresController, SesDeliveryEventsController } from "./ses-delivery-events.controller";
import { EmailReadbackPendingError } from "./ses-delivery-events.service";

describe("SesDeliveryEventsController", () => {
  it("requires the configured webhook secret", async () => {
    const controller = new SesDeliveryEventsController(
      { handle: vi.fn() } as never,
      { webhookSecret: "secret" },
    );
    await expect(controller.receive("wrong", {})).rejects.toMatchObject({
      status: 401,
      response: expect.objectContaining({ error_code: "SES_WEBHOOK_UNAUTHORIZED" }),
    });
  });
  it("keeps provider retries distinct from malformed input and never exposes database errors", async () => {
    const handle = vi.fn().mockRejectedValueOnce(new EmailReadbackPendingError()).mockRejectedValueOnce(new Error("database unavailable"));
    const controller = new SesDeliveryEventsController({ handle } as never, { webhookSecret: "fixture" });
    const body = { eventType: "Delivery", mail: { messageId: "fixture", tags: { alter_tenant_id: ["ten_00000000-0000-7000-8000-000000000001"] } } };
    await expect(controller.receive("fixture", body)).rejects.toMatchObject({ status: 503 });
    await expect(controller.receive("fixture", body)).rejects.toThrow("database unavailable");
    await expect(controller.receive("fixture", null)).rejects.toMatchObject({ status: 400 });
    await expect(new SesDeliveryEventsController({ handle } as never, { webhookSecret: undefined }).receive("fixture", body)).rejects.toMatchObject({ status: 401 });
  });
  it("rejects missing or non-system identity before reading the failure feed", async () => {
    const failures = vi.fn(); const controller = new EmailDeliveryFailuresController({ failures } as never);
    await expect(controller.list({} as never)).rejects.toMatchObject({ status: 403 });
    await expect(controller.list({ actorContext: { actor_type: "user" } } as never)).rejects.toMatchObject({ status: 403 });
    expect(failures).not.toHaveBeenCalled();
  });
});
