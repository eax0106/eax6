import { describe, expect, it } from "vitest";
import { parseSesDeliveryEvent } from "./ses-delivery-events.service";

const tenant = "ten_00000000-0000-7000-8000-000000000001";
const bounce = { eventType: "Bounce", mail: { messageId: "ses-1", tags: { alter_tenant_id: [tenant] } }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ diagnosticCode: "recipient@example.com" }] } };

describe("SES event boundary", () => {
  it("parses direct, EventBridge and SNS payloads without retaining recipient diagnostics", () => {
    const expected = { type: "Bounce", messageId: "ses-1", tenantId: tenant, reason: "Permanent" };
    expect(parseSesDeliveryEvent(bounce)).toEqual(expected);
    expect(parseSesDeliveryEvent({ detail: bounce })).toEqual(expected);
    expect(parseSesDeliveryEvent({ Type: "Notification", Message: JSON.stringify(bounce) })).toEqual(expected);
    expect(parseSesDeliveryEvent({ ...bounce, bounce: { bounceType: "recipient@example.com" } }).reason).toBe("Undetermined");
    expect(parseSesDeliveryEvent({ ...bounce, eventType: "Delivery" })).toEqual({ type: "Delivery", messageId: "ses-1", tenantId: tenant });
  });
  it.each([null, [], { eventType: "Open" }, { ...bounce, mail: {} }, { ...bounce, mail: { messageId: "x", tags: { alter_tenant_id: ["foreign"] } } }, { ...bounce, mail: { messageId: " " } }])("rejects malformed provider identity: %j", input => {
    expect(() => parseSesDeliveryEvent(input)).toThrow();
  });
});
