import { Injectable, Logger } from "@nestjs/common";
import { EngineClient } from "../../engine";
import type { JsonValue } from "@alterx/shared-clients";
import { NotificationService } from "../notification.service";
import { bareId, type EngineEventProducer, type EngineEventProducerContext } from "./engine-event-producer";

interface RecoveryPage {
  readonly data: readonly Readonly<Record<string, JsonValue>>[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

/** A repair counts as new for this long after it worked. */
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

/**
 * Self-heal happened (design log section 4, D1): a step failed, Alter repaired
 * it and the run kept going. Tells each workspace admin and editor once per
 * RUN, however many repairs it needed, so a flaky run is one notice, not five.
 * Informational: there is nothing for the reader to do.
 */
@Injectable()
export class SelfHealProducer implements EngineEventProducer {
  readonly name = "self-heal";
  private readonly logger = new Logger(SelfHealProducer.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly notifications: NotificationService,
  ) {}

  async produce(context: EngineEventProducerContext): Promise<number> {
    const resolvedAfter = new Date(context.now.getTime() - LOOKBACK_MS).toISOString();
    let created = 0;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: string = `resolved_after=${encodeURIComponent(resolvedAfter)}&limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response: { body: RecoveryPage } = await this.engine.get<RecoveryPage>(
        `/api/v1/recovery-actions?${query}`,
        context.caller,
      );
      for (const action of response.body.data) {
        created += await this.notify(context.tenantId, action);
      }
      if (!response.body.page.has_more || response.body.page.next_cursor === null) break;
      cursor = response.body.page.next_cursor;
    }
    return created;
  }

  private async notify(tenantId: string, action: Readonly<Record<string, JsonValue>>): Promise<number> {
    const runId = typeof action.run_id === "string" ? action.run_id : null;
    const workspaceId = bareId("ws", action.workspace_id);
    if (runId === null || workspaceId === null) {
      this.logger.warn({ tenantId, message: "recovery has no run or workspace; not notified" });
      return 0;
    }
    try {
      return await this.notifications.notifyWorkspaceRolesOnce(["admin", "editor"], `self-heal:${runId}`, {
        tenantId,
        workspaceId,
        eventClass: "workflow",
        severity: "info",
        title: "Alter fixed a problem in a run",
        body: "A step failed and Alter repaired it, so the run kept going. There is nothing you need to do.",
        deepLink: `/app/runs/${encodeURIComponent(runId)}`,
        sourceService: "platform-api.engine-events",
      });
    } catch (error: unknown) {
      this.logger.error({
        tenantId,
        runId,
        message: "self-heal notification failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
