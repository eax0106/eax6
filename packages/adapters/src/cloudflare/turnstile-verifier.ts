import { z } from "zod";

const request = z.object({
  response: z.string().min(1).max(2048),
  formContext: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  idempotencyKey: z.string().uuid(),
}).strict();
const result = z.object({
  success: z.literal(true), hostname: z.string(), action: z.literal("public_form"),
  cdata: z.string(), challenge_ts: z.string().datetime(),
});

/** Server-side Siteverify; widget tokens alone never authorize a submission. */
export class CloudflareTurnstileVerifier {
  constructor(private readonly secret: () => Promise<string>, private readonly hostname: string,
    private readonly http: typeof fetch = fetch) {}

  async verify(input: { response: string; formContext: string; idempotencyKey: string }): Promise<boolean> {
    const parsed = request.safeParse(input);
    if (!parsed.success || !this.hostname) return false;
    try {
      const secret = await this.secret();
      if (!secret.trim()) return false;
      const response = await this.http("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, response: parsed.data.response, idempotency_key: parsed.data.idempotencyKey }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return false;
      const verified = result.safeParse(await response.json());
      if (!verified.success || verified.data.hostname !== this.hostname || verified.data.cdata !== parsed.data.formContext) return false;
      const age = Date.now() - Date.parse(verified.data.challenge_ts);
      return age >= -60000 && age <= 300000;
    } catch { return false; }
  }
}
