import { describe, expect, it, vi } from "vitest";
import type { SecretsProvider } from "@alterx/shared-clients";
import { MetaCloudApiWhatsappProvider } from "./meta-cloud-api-whatsapp-provider";

describe("MetaCloudApiWhatsappProvider", () => {
  it("sends a free-form text reply and returns Meta's message id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.text" }] }), { status: 200 }));
    const provider = new MetaCloudApiWhatsappProvider({ getSecret: vi.fn().mockResolvedValue("token") } as unknown as SecretsProvider, fetchImpl);
    await expect(provider.sendTextMessage({ phoneNumberId: "phone-1", wabaId: "waba-1", accessTokenRef: "ref" }, "15551234567", "Open 9 to 5"))
      .resolves.toEqual({ messageId: "wamid.text" });
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      messaging_product: "whatsapp", to: "15551234567", type: "text", text: { body: "Open 9 to 5", preview_url: false } });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    await expect(provider.sendTextMessage({ phoneNumberId: "phone-1", wabaId: "waba-1", accessTokenRef: "ref" }, "1", "x"))
      .rejects.toThrow("returned no message id");
  });

  it("resolves an access-token reference and sends a Meta template request", async () => {
    const getSecret = vi.fn().mockResolvedValue("meta-access-token");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
    const provider = new MetaCloudApiWhatsappProvider(
      { getSecret } as unknown as SecretsProvider,
      fetchImpl,
    );

    await expect(provider.sendTemplateMessage(
      { phoneNumberId: "phone-1", wabaId: "waba-1", accessTokenRef: "secret://tenant/token" },
      "15551234567", "hello_world",
    )).resolves.toEqual({ messageId: "wamid.1" });

    expect(getSecret).toHaveBeenCalledWith("secret://tenant/token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://graph.facebook.com/v21.0/phone-1/messages",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer meta-access-token" }) }),
    );
    const request = fetchImpl.mock.calls[0];
    expect(request).toBeDefined();
    expect(JSON.parse((request![1] as RequestInit).body as string)).toEqual({
      messaging_product: "whatsapp", to: "15551234567", type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });
  });
});
