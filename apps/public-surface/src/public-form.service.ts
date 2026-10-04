import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { hostedFormValuesSchema, TriggerDispatchDetailSchema } from "@alterx/contracts";
import { PromptInjectionClassifier, PublicFormTokenCodec } from "@alterx/auth";
import type { CloudflareTurnstileVerifier, EventBridgeEventPublisher, RedisPublicFormRateLimiter, RedisPublicFormReceiptStore } from "@alterx/adapters";
import type { PublicFormRepository } from "./public-form.repository";

const submission = z.object({ submissionId: z.string().uuid(), turnstileResponse: z.string().min(1).max(2048), values: z.record(z.string(), z.unknown()) }).strict();
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
export class PublicFormHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** @driver createPublicSurfaceServer */
export class PublicFormService {
  constructor(private readonly codec: PublicFormTokenCodec, private readonly repository: Pick<PublicFormRepository, "get">,
    private readonly rates: { page: Pick<RedisPublicFormRateLimiter, "consume">; submit: Pick<RedisPublicFormRateLimiter, "consume"> },
    private readonly turnstile: Pick<CloudflareTurnstileVerifier, "verify">,
    private readonly classifier: Pick<PromptInjectionClassifier, "classify">,
    private readonly receipts: Pick<RedisPublicFormReceiptStore, "get" | "reserve" | "markPublished">,
    private readonly publisher: Pick<EventBridgeEventPublisher, "publish">, private readonly visitorKey: string) {}

  private async resolve(token: string, visitor: string, mode: "page" | "submit") {
    const claims = this.codec.parse(token);
    const context = claims ? digest(`${claims.tenantId}:${claims.triggerId}:${claims.triggerVersionId}`) : digest("invalid-form");
    const visitorHash = createHmac("sha256", this.visitorKey).update(visitor).digest("hex");
    if (!await this.rates[mode].consume(context, visitorHash)) throw new PublicFormHttpError(429, "Please try again later");
    if (!claims) throw new PublicFormHttpError(404, "Form unavailable");
    const form = await this.repository.get(claims);
    if (!form) throw new PublicFormHttpError(404, "Form unavailable");
    return { claims, form, context };
  }
  async page(token: string, visitor: string) {
    const { form, context } = await this.resolve(token, visitor, "page");
    return { definition: form.definition, context };
  }
  async submit(token: string, visitor: string, body: unknown): Promise<void> {
    const { claims, form, context } = await this.resolve(token, visitor, "submit");
    const input = submission.safeParse(body);
    if (!input.success) throw new PublicFormHttpError(400, "Invalid submission");
    const fields = hostedFormValuesSchema(form.definition).safeParse(input.data.values);
    if (!fields.success || Buffer.byteLength(JSON.stringify(fields.data)) > 32768) throw new PublicFormHttpError(400, "Invalid form fields");
    const values = fields.data, payloadHash = digest(JSON.stringify(values));
    const receiptKey = digest(`${context}:${input.data.submissionId.toLowerCase()}`);
    const receipt = await this.receipts.get(receiptKey);
    if (receipt && receipt.payloadHash !== payloadHash) throw new PublicFormHttpError(409, "Submission identifier already used");
    if (receipt?.published) return;
    if (!receipt) {
      if (!await this.turnstile.verify({ response: input.data.turnstileResponse, formContext: context, idempotencyKey: input.data.submissionId })) throw new PublicFormHttpError(400, "Complete the verification challenge again");
      const classification = await this.classifier.classify({ tenantId: claims.tenantId, runId: `run_${randomUUID()}`, nodeExecutionId: `node_${randomUUID()}`, text: JSON.stringify(values) });
      if (classification.failOpenCause) throw new PublicFormHttpError(503, "Submission checks temporarily unavailable");
      if (classification.blocked) throw new PublicFormHttpError(400, "Submission could not be accepted");
      if (!await this.receipts.reserve(receiptKey, payloadHash)) throw new PublicFormHttpError(409, "Submission identifier already used");
    }
    // Recheck state after challenge/model work; the engine also rejects retired form versions.
    if (!await this.repository.get(claims)) throw new PublicFormHttpError(404, "Form unavailable");
    const detail = TriggerDispatchDetailSchema.parse({ source: "alter.public-form", detail_type: "trigger.delivered", event_type: "public_form.submitted", schema_version: "1",
      tenant_id: claims.tenantId, workspace_id: form.workspaceId, trigger_id: claims.triggerId, trigger_version: form.version,
      idempotency_key: `public-form:${receiptKey}`, payload: values, dlq_max_receive_count: form.dlqMaxReceiveCount });
    await this.publisher.publish({ source: detail.source, detailType: detail.detail_type, detail });
    await this.receipts.markPublished(receiptKey, payloadHash);
  }
}
