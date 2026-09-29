import { Injectable, Logger } from "@nestjs/common";
import { EngineClient } from "../../engine";
import type { JsonValue } from "@alterx/shared-clients";
import { NotificationService } from "../notification.service";
import { bareId, type EngineEventProducer, type EngineEventProducerContext } from "./engine-event-producer";

interface ApprovalPage {
  readonly data: readonly Readonly<Record<string, JsonValue>>[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

const PAGE_SIZE = 50;
const MAX_PAGES = 4;

/**
 * Approval waiting (D5 delivery, D1): tells each workspace admin and approver
 * once per pending approval. Reads every pending approval on each pass and
 * lets the dedupe key drop the ones already told, so an approval that stays
 * pending is not announced again and one raised while a pass was down is
 * still found. A pending approval is never old news: it is announced as long
 * as it waits.
 */
@Injectable()
export class ApprovalWaitingProducer implements EngineEventProducer {
  readonly name = "approval-waiting";
  private readonly logger = new Logger(ApprovalWaitingProducer.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly notifications: NotificationService,
  ) {}

  async produce(context: EngineEventProducerContext): Promise<number> {
    let created = 0;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: string = `status=pending&limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response: { body: ApprovalPage } = await this.engine.get<ApprovalPage>(
        `/api/v1/approvals?${query}`,
        context.caller,
      );
      for (const approval of response.body.data) {
        created += await this.notify(context.tenantId, approval);
      }
      if (!response.body.page.has_more || response.body.page.next_cursor === null) break;
      cursor = response.body.page.next_cursor;
    }
    return created;
  }

  private async notify(tenantId: string, approval: Readonly<Record<string, JsonValue>>): Promise<number> {
    const approvalId = typeof approval.id === "string" ? approval.id : null;
    const workspaceId = bareId("ws", approval.workspace_id);
    if (approvalId === null || workspaceId === null) {
      this.logger.warn({ tenantId, message: "pending approval has no id or workspace; not notified" });
      return 0;
    }
    try {
      return await this.notifications.notifyWorkspaceRolesOnce(["admin", "approver"], `approval.requested:${approvalId}`, {
        tenantId,
        workspaceId,
        eventClass: "approval",
        severity: "warning",
        title: "An approval is waiting for you",
        body: "A workflow has paused and needs a decision before it can continue.",
        deepLink: `/app/human-actions/${encodeURIComponent(approvalId)}`,
        sourceService: "platform-api.engine-events",
      });
    } catch (error: unknown) {
      this.logger.error({
        tenantId,
        approvalId,
        message: "approval-waiting notification failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
