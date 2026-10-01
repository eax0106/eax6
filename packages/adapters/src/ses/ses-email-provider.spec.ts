import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it, vi } from "vitest";
import { MockEmailProvider } from "./mock-email-provider";
import { SesEmailProvider, type SesCommandClient } from "./ses-email-provider";

const now = () => new Date("2026-08-05T00:00:00.000Z");

describe("SesEmailProvider", () => {
  it("tags workflow email for read-back while notification templates stay outside that route", async () => {
    const send = vi.fn<SesCommandClient["send"]>().mockResolvedValue({ MessageId: "accepted" });
    const provider = new SesEmailProvider({ region: "ap-south-1", fromAddress: "no-reply@example.com", credentialsSecretRef: "ref", configurationSetName: "alter-dev-delivery" }, vi.fn(), { send }, now);
    await provider.sendEmail("person@example.com", "Hello", "Body", { tenantId: "ten_fixture" });
    const raw = (send.mock.calls[0]![0] as SendEmailCommand).input;
    expect(raw.ConfigurationSetName).toBe("alter-dev-delivery");
    expect(raw.EmailTags).toEqual([{ Name: "alter_tenant_id", Value: "ten_fixture" }]);
    await provider.sendTemplatedEmail("person@example.com", "notice", {});
    const template = (send.mock.calls[1]![0] as SendEmailCommand).input;
    expect(template.ConfigurationSetName).toBe("alter-dev-delivery");
    expect(template.EmailTags).toBeUndefined();
  });
  it("sends a real SES template-shaped request", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(SendEmailCommand);
      const input = (command as SendEmailCommand).input;
      expect(input.FromEmailAddress).toBe("notifications@alter.ai");
      expect(input.Destination?.ToAddresses).toEqual(["user@example.com"]);
      expect(input.Content?.Template).toEqual({
        TemplateName: "notification-workflow-hi-IN",
        TemplateData: JSON.stringify({ title: "Run failed" }),
      });
      return { MessageId: "ses-message-1" };
    });
    const provider = new SesEmailProvider(
      {
        region: "ap-south-1",
        fromAddress: "notifications@alter.ai",
        credentialsSecretRef: "/alter/dev/notifications/system/ses-credentials",
      },
      vi.fn(),
      { send } as unknown as SesCommandClient,
      now,
    );

    await expect(
      provider.sendTemplatedEmail(
        "user@example.com",
        "notification-workflow",
        { title: "Run failed" },
        "hi-IN",
      ),
    ).resolves.toEqual({ messageId: "ses-message-1", acceptedAt: now().toISOString() });
  });

  it("requires a SES message ID", async () => {
    const provider = new SesEmailProvider(
      { region: "ap-south-1", fromAddress: "notifications@alter.ai", credentialsSecretRef: "ref" },
      vi.fn(),
      { send: vi.fn(async () => ({})) } as unknown as SesCommandClient,
    );
    await expect(provider.sendTemplatedEmail("user@example.com", "notification-system", {})).rejects.toThrow(
      "SES did not return a message ID",
    );
  });

  it("mock adapter records same contract input", async () => {
    const provider = new MockEmailProvider(now);
    await expect(provider.sendTemplatedEmail("user@example.com", "notification-system", { title: "Hello" })).resolves.toEqual({
      messageId: "mock-email-1",
      acceptedAt: now().toISOString(),
    });
    expect(provider.sent).toEqual([
      { to: "user@example.com", templateId: "notification-system", variables: { title: "Hello" }, locale: undefined },
    ]);
  });

  it("sends a real SES Content.Simple-shaped request, not Content.Template", async () => {
    const send = vi.fn(async (command: unknown) => {
      const input = (command as SendEmailCommand).input;
      expect(input.FromEmailAddress).toBe("notifications@alter.ai");
      expect(input.Destination?.ToAddresses).toEqual(["user@example.com"]);
      expect(input.Content?.Template).toBeUndefined();
      expect(input.Content?.Simple).toEqual({
        Subject: { Data: "Run failed" },
        Body: { Text: { Data: "See the run detail page for the failure reason." } },
      });
      return { MessageId: "ses-message-2" };
    });
    const provider = new SesEmailProvider(
      {
        region: "ap-south-1",
        fromAddress: "notifications@alter.ai",
        credentialsSecretRef: "/alter/dev/notifications/system/ses-credentials",
      },
      vi.fn(),
      { send } as unknown as SesCommandClient,
      now,
    );

    await expect(
      provider.sendEmail(
        "user@example.com",
        "Run failed",
        "See the run detail page for the failure reason.",
      ),
    ).resolves.toEqual({ messageId: "ses-message-2", acceptedAt: now().toISOString() });
  });

  it("sends Body.Html instead of Body.Text when options.html is true", async () => {
    const send = vi.fn(async (command: unknown) => {
      const input = (command as SendEmailCommand).input;
      expect(input.Content?.Simple?.Body).toEqual({ Html: { Data: "<p>Hi</p>" } });
      return { MessageId: "ses-message-3" };
    });
    const provider = new SesEmailProvider(
      { region: "ap-south-1", fromAddress: "notifications@alter.ai", credentialsSecretRef: "ref" },
      vi.fn(),
      { send } as unknown as SesCommandClient,
      now,
    );

    await provider.sendEmail("user@example.com", "Hi", "<p>Hi</p>", { html: true });
  });

  it("rejects a subject+body combination larger than SES's declared maximum payload before ever calling SES", async () => {
    const send = vi.fn();
    const provider = new SesEmailProvider(
      { region: "ap-south-1", fromAddress: "notifications@alter.ai", credentialsSecretRef: "ref" },
      vi.fn(),
      { send } as unknown as SesCommandClient,
      now,
    );
    const oversizedBody = "x".repeat(11_000_000);

    await expect(
      provider.sendEmail("user@example.com", "Subject", oversizedBody),
    ).rejects.toThrow(/exceeds SES's maximum payload/);
    expect(send).not.toHaveBeenCalled();
  });

  it("requires a SES message ID for sendEmail too", async () => {
    const provider = new SesEmailProvider(
      { region: "ap-south-1", fromAddress: "notifications@alter.ai", credentialsSecretRef: "ref" },
      vi.fn(),
      { send: vi.fn(async () => ({})) } as unknown as SesCommandClient,
    );
    await expect(provider.sendEmail("user@example.com", "Subject", "Body")).rejects.toThrow(
      "SES did not return a message ID",
    );
  });

  it("mock adapter records sendEmail calls separately from sendTemplatedEmail", async () => {
    const provider = new MockEmailProvider(now);
    await expect(provider.sendEmail("user@example.com", "Subject", "Body text")).resolves.toEqual({
      messageId: "mock-email-1",
      acceptedAt: now().toISOString(),
    });
    expect(provider.sentRaw).toEqual([
      { to: "user@example.com", subject: "Subject", body: "Body text", html: undefined },
    ]);
    expect(provider.sent).toEqual([]);
  });
});
