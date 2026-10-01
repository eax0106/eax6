import { TenantIdSchema } from "@alterx/contracts";
import type { OrchestrationTenantStore } from "../runs/node-execution-ledger.service";
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
    : outer.detail ?? input;
  const body = record(message);
  const type = body.eventType;
  if (type !== "Delivery" && type !== "Bounce") throw new Error("SES event type must be Delivery or Bounce");
  const mail = record(body.mail);
  const messageId = stringValue(mail.messageId, "SES mail.messageId");
  const tags = record(mail.tags);
  const tenant = Array.isArray(tags.alter_tenant_id) ? tags.alter_tenant_id[0] : undefined;
  const tenantId = TenantIdSchema.parse(stringValue(tenant, "SES alter_tenant_id tag"));
  const bounce = record(body.bounce);
  const reason = type === "Bounce"
    ? (["Permanent", "Transient", "Undetermined"].includes(String(bounce.bounceType)) ? String(bounce.bounceType) : "Undetermined")
    : undefined;
  return { type, messageId, tenantId, ...(reason === undefined ? {} : { reason }) };
}

export class SesDeliveryEventsService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly stream: RunStreamEventService,
  ) {}

  async handle(event: SesDeliveryEvent): Promise<{ readonly matched: boolean }> {
    const tenantId = TenantIdSchema.parse(event.tenantId).slice(4);
    return this.store.withTenant(tenantId, async tx => {
      const result = await tx.query<{ readonly id: string; readonly run_id: string; readonly status: string }>(
        `SELECT id, run_id, status FROM side_effects
         WHERE tenant_id = $1 AND provider_message_id = $2 AND tool_name = 'email.send' FOR UPDATE`,
        [tenantId, event.messageId],
      );
      const effect = result.rows[0];
      // SES may arrive before the accepted message id is committed. Let EventBridge retry.
      if (effect === undefined) throw new EmailReadbackPendingError();
      if (effect.status === "delivery_failed") return { matched: true };
      if (event.type === "Delivery") {
        await tx.query(`UPDATE side_effects SET delivery_confirmed_at = COALESCE(delivery_confirmed_at, clock_timestamp())
          WHERE tenant_id = $1 AND id = $2`, [tenantId, effect.id]);
      } else {
        await tx.query(`UPDATE side_effects SET status = 'delivery_failed', delivery_failure_reason = $3,
          delivery_failed_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, effect.id, event.reason ?? "Undetermined"]);
        const run = await tx.query<{ readonly status: "failed" | "cancelled" }>(`UPDATE runs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'failed' END,
          ended_at = COALESCE(ended_at, clock_timestamp()),
          flags = CASE WHEN 'email_delivery_failed' = ANY(flags) THEN flags ELSE array_append(flags, 'email_delivery_failed') END
          WHERE tenant_id = $1 AND id = $2 RETURNING status`, [tenantId, effect.run_id]);
        if (run.rows[0]?.status !== "cancelled") {
          await this.stream.appendWithinTransaction(tx, tenantId, effect.run_id, {
            event: "run.status", data: { status: "failed", reason: "Email delivery failed" },
          });
        }
      }
      return { matched: true };
    });
  }

  async failures(tenantIdInput: string, cursor?: string) {
    const tenantId = TenantIdSchema.parse(tenantIdInput).slice(4);
    return this.store.withTenant(tenantId, async tx => {
      const result = await tx.query<{ readonly id: string; readonly run_id: string; readonly workspace_id: string }>(
        `SELECT s.id, s.run_id, r.workspace_id::text AS workspace_id
         FROM side_effects s JOIN runs r ON r.tenant_id = s.tenant_id AND r.id = s.run_id
         WHERE s.tenant_id = $1 AND s.delivery_failed_at IS NOT NULL AND ($2::text IS NULL OR s.id > $2)
         ORDER BY s.id LIMIT 100`, [tenantId, cursor ?? null]);
      return { data: result.rows.map(row => ({ ...row, workspace_id: `ws_${row.workspace_id}` })),
        page: { next_cursor: result.rows.length === 100 ? result.rows.at(-1)!.id : null } };
    });
  }

}

export class EmailReadbackPendingError extends Error {
  constructor() { super("Accepted email has not been recorded yet"); }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}
