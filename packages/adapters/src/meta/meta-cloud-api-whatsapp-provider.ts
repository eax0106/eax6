import type { SecretsProvider } from "@alterx/shared-clients";

export interface WhatsappProviderAccount { readonly phoneNumberId: string; readonly wabaId: string; readonly accessTokenRef: string; }
export interface WhatsappTemplate { readonly name: string; readonly language: string; readonly status: string; }

export class MetaCloudApiWhatsappProvider {
  constructor(private readonly secrets: SecretsProvider, private readonly fetchImpl: typeof fetch = fetch, private readonly baseUrl = "https://graph.facebook.com/v21.0") {}
  async sendTemplateMessage(account: WhatsappProviderAccount, to: string, templateName: string, languageCode = "en_US"): Promise<{ readonly messageId: string }> {
    const body = await this.call(account, `/${encodeURIComponent(account.phoneNumberId)}/messages`, "POST", { messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: languageCode } } });
    return { messageId: firstMessageId(body) };
  }
  /** A free-form reply; Meta accepts it only inside the customer's 24-hour service window. */
  async sendTextMessage(account: WhatsappProviderAccount, to: string, text: string): Promise<{ readonly messageId: string }> {
    const body = await this.call(account, `/${encodeURIComponent(account.phoneNumberId)}/messages`, "POST", { messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: false } });
    return { messageId: firstMessageId(body) };
  }
  async getTemplates(account: WhatsappProviderAccount): Promise<readonly WhatsappTemplate[]> {
    const body = await this.call(account, `/${encodeURIComponent(account.wabaId)}/message_templates`, "GET");
    return (Array.isArray(body.data) ? body.data : []).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const row = item as Record<string, unknown>;
      return typeof row.name === "string" && typeof row.language === "string" && typeof row.status === "string" ? [{ name: row.name, language: row.language, status: row.status }] : [];
    });
  }
  async getAccountHealth(account: WhatsappProviderAccount): Promise<{ readonly status: "healthy" | "unhealthy" }> { try { await this.call(account, `/${encodeURIComponent(account.phoneNumberId)}?fields=id`, "GET"); return { status: "healthy" }; } catch { return { status: "unhealthy" }; } }
  private async call(account: WhatsappProviderAccount, path: string, method: "GET" | "POST", requestBody?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${await this.secrets.getSecret(account.accessTokenRef)}`, ...(requestBody ? { "content-type": "application/json" } : {}) }, ...(requestBody ? { body: JSON.stringify(requestBody) } : {}) });
    const text = await response.text(); const body: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) throw new MetaCloudApiWhatsappError(response.status, "Meta Cloud API request failed");
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new MetaCloudApiWhatsappError(502, "Meta Cloud API returned an invalid response");
    return body as Record<string, unknown>;
  }
}
function firstMessageId(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  const id = typeof first === "object" && first !== null && typeof (first as Record<string, unknown>).id === "string" ? (first as Record<string, string>).id : undefined;
  if (!id) throw new MetaCloudApiWhatsappError(502, "Meta Cloud API returned no message id");
  return id;
}
export class MetaCloudApiWhatsappError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = "MetaCloudApiWhatsappError"; } }
