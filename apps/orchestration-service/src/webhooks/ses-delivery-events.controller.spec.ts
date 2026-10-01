import { describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import { SesDeliveryEventsController } from "./ses-delivery-events.controller";

describe("SesDeliveryEventsController", () => {
  it("requires the configured webhook secret", async () => {
    const controller = new SesDeliveryEventsController(
      { handle: vi.fn() } as never,
      { webhookSecret: "secret" },
    );
    await expect(controller.receive("wrong", {})).rejects.toMatchObject({
      status: 401,
      response: expect.objectContaining({ error_code: "SES_WEBHOOK_UNAUTHORIZED" }),
    } satisfies Partial<HttpException>);
  });
});
