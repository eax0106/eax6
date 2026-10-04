import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTurnstileVerifier } from "./turnstile-verifier";
const input = { response: "widget-fixture-token", formContext: "form_fixture", idempotencyKey: randomUUID() };
const success = () => ({ success: true, hostname: "forms.example.test", action: "public_form", cdata: input.formContext, challenge_ts: new Date().toISOString() });
afterEach(() => vi.useRealTimers());
describe("Cloudflare Turnstile server verification", () => {
  it("calls fixed Siteverify with the secret and stable validation key, and validates the form context", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json(success()));
    expect(await new CloudflareTurnstileVerifier(async () => "fixture-secret", "forms.example.test", http).verify(input)).toBe(true);
    const [url, init] = http.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(JSON.parse(String(init!.body))).toEqual({ secret: "fixture-secret", response: input.response, idempotency_key: input.idempotencyKey });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it("refuses expired/duplicate, failed, incomplete and differently bound verification", async () => {
    const cases = [{ success: false, "error-codes": ["timeout-or-duplicate"] }, {}, { ...success(), hostname: "other.example.test" }, { ...success(), action: "login" }, { ...success(), cdata: "another_form" }, { ...success(), challenge_ts: new Date(Date.now() - 301000).toISOString() }, { ...success(), challenge_ts: new Date(Date.now() + 61000).toISOString() }];
    for (const body of cases) {
      const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      expect(await new CloudflareTurnstileVerifier(async () => "fixture-secret", "forms.example.test", http).verify(input)).toBe(false);
    }
  });
  it("does not call an external service for invalid input or missing configuration", async () => {
    const http = vi.fn<typeof fetch>(), verifier = new CloudflareTurnstileVerifier(async () => "fixture-secret", "forms.example.test", http);
    for (const value of [{ ...input, response: "" }, { ...input, response: "x".repeat(2049) }, { ...input, formContext: "not/allowed" }, { ...input, idempotencyKey: "not-a-uuid" }]) expect(await verifier.verify(value)).toBe(false);
    expect(await new CloudflareTurnstileVerifier(async () => "", "forms.example.test", http).verify(input)).toBe(false);
    expect(await new CloudflareTurnstileVerifier(async () => "fixture-secret", "", http).verify(input)).toBe(false);
    expect(http).not.toHaveBeenCalled();
  });
  it("keeps network/secret/HTTP/invalid-output failures closed", async () => {
    for (const http of [vi.fn<typeof fetch>().mockRejectedValue(new Error("Timeout")), vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 })), vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"))]) expect(await new CloudflareTurnstileVerifier(async () => "fixture-secret", "forms.example.test", http).verify(input)).toBe(false);
    const http = vi.fn<typeof fetch>();
    expect(await new CloudflareTurnstileVerifier(async () => { throw new Error("Secret unavailable"); }, "forms.example.test", http).verify(input)).toBe(false);
    expect(http).not.toHaveBeenCalled();
  });
});
