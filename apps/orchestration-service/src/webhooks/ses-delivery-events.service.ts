import { TenantIdSchema } from "@alterx/contracts";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { RunStreamEventService } from "../runs/run-stream-event.service";

export interface SesDeliveryEvent {
  readonly type: "Delivery" | "Bounce";
  readonly messageId: string;
  readonly tenantId: string;
  readonly reason?: string;
}

export function parseSesDeliveryEvent(input: unknown): SesDeliveryEvent {
  const outer = record(input);
  const message = outer.Type === "Notification" && typeof outer.Message === "string"
    ? JSON.parse(outer.Message) as unknown
    : input;
  const body = record(message);
  const type = body.eventType;
  if (type !== "Delivery" && type !== "Bounce") throw new Error("SES event type must be Delivery or Bounce");
  const mail = record(body.mail);
  const messageId = stringValue(mail.messageId, "SES mail.messageId");
  const tags = record(mail.tags);
  const tenant = Array.isArray(tags.alter_tenant_id) ? tags.alter_tenant_id[0] : body.tenant_id;
  const tenantId = TenantIdSchema.parse(stringValue(tenant, "SES alter_tenant_id tag"));
  const bounce = record(body.bounce);
  const recipients = Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : [];
  const diagnostic = record(recipients[0]).diagnosticCode;
  const reason = type === "Bounce"
    ? String(bounce.bounceType ?? diagnostic ?? "SES reported a bounce")
    : undefined;
  return { type, messageId, tenantId, ...(reason === undefined ? {} : { reason }) };
}

export class SesDeliveryEventsService {
  constructor(
    private readonly ledger: NodeExecutionLedgerService,
    private readonly stream: RunStreamEventService,
  ) {}

  async handle(event: SesDeliveryEvent): Promise<{ readonly matched: boolean }> {
    if (event.type === "Delivery") return { matched: false };
    const result = await this.ledger.markEmailDeliveryFailed(
      event.tenantId,
      event.messageId,
      event.reason ?? "SES reported a bounce",
    );
    if (result === undefined) return { matched: false };
    await this.stream.append(event.tenantId, result.runId, {
      event: "run.status",
      data: { status: "failed", reason: "Email delivery failed" },
    });
    return { matched: true };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}
