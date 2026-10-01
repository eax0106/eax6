import { Injectable, Logger } from "@nestjs/common";
import type { JsonValue } from "@alterx/shared-clients";
import { EngineClient } from "../../engine";
import { NotificationService } from "../notification.service";
import { bareId, type EngineEventProducer, type EngineEventProducerContext } from "./engine-event-producer";

@Injectable()
export class EmailDeliveryFailedProducer implements EngineEventProducer {
  readonly name = "email-delivery-failed";
  private readonly logger = new Logger(EmailDeliveryFailedProducer.name);

  constructor(private readonly engine: EngineClient, private readonly notifications: NotificationService) {}

  async produce(context: EngineEventProducerContext): Promise<number> {
    let created = 0;
    let cursor: string | null = null;
    // ponytail: scan retained failure pages; add a platform watermark if history scans become costly.
    do {
      const response: { body: { readonly data: readonly Readonly<Record<string, JsonValue>>[]; readonly page: { readonly next_cursor: string | null } } } =
        await this.engine.get(`/api/v1/email-delivery-failures${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, context.caller);
      for (const failure of response.body.data) {
        const workspaceId = bareId("ws", failure.workspace_id);
        if (!workspaceId || typeof failure.id !== "string" || !failure.id ||
            typeof failure.run_id !== "string" || !failure.run_id) continue;
        try {
          created += await this.notifications.notifyWorkspaceRolesOnce(["admin", "editor"], `email.delivery-failed:${failure.id}`, {
            tenantId: context.tenantId, workspaceId, eventClass: "workflow", severity: "critical",
            title: "Email delivery failed", body: "An email accepted during this run later bounced. Open the run to review it.",
            deepLink: `/app/runs/${encodeURIComponent(failure.run_id)}`, sourceService: "platform-api.engine-events",
          });
        } catch (error: unknown) {
          this.logger.error({ tenantId: context.tenantId, message: "email delivery notification failed",
            error: error instanceof Error ? error.message : String(error) });
        }
      }
      const next = response.body.page.next_cursor;
      if (next !== null && (next === cursor || response.body.data.length === 0)) throw new Error("Delivery failure cursor did not advance");
      cursor = next;
    } while (cursor !== null);
    return created;
  }
}
