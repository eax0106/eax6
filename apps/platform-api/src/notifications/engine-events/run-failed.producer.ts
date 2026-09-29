import { Injectable, Logger } from "@nestjs/common";
import { EngineClient } from "../../engine";
import type { JsonValue } from "@alterx/shared-clients";
import { NotificationService } from "../notification.service";
import { bareId, type EngineEventProducer, type EngineEventProducerContext } from "./engine-event-producer";

interface RunPage {
  readonly data: readonly Readonly<Record<string, JsonValue>>[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

/** A failure counts as new for this long after the run ended. */
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** The engine lists newest first by creation; a run created earlier than this is not looked at. */
const CREATED_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

/**
 * Run failed (design log §16 notice, D1): tells each workspace admin and
 * editor once per failed run. Bounds are deliberate: a tenant with more than
 * MAX_PAGES x PAGE_SIZE failures in a day is told about the newest ones.
 */
@Injectable()
export class RunFailedProducer implements EngineEventProducer {
  readonly name = "run-failed";
  private readonly logger = new Logger(RunFailedProducer.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly notifications: NotificationService,
  ) {}

  async produce(context: EngineEventProducerContext): Promise<number> {
    const endedAfter = context.now.getTime() - LOOKBACK_MS;
    const createdAfter = context.now.getTime() - CREATED_WINDOW_MS;
    let created = 0;
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: string = `status=failed&limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response: { body: RunPage } = await this.engine.get<RunPage>(
        `/api/v1/runs?${query}`,
        context.caller,
      );
      let oldestCreated = Number.POSITIVE_INFINITY;
      for (const run of response.body.data) {
        oldestCreated = Math.min(oldestCreated, Date.parse(String(run.created_at ?? "")) || 0);
        const endedAt = Date.parse(String(run.ended_at ?? ""));
        if (Number.isNaN(endedAt) || endedAt < endedAfter) continue;
        created += await this.notify(context.tenantId, run);
      }
      if (!response.body.page.has_more || response.body.page.next_cursor === null) break;
      if (oldestCreated < createdAfter) break;
      cursor = response.body.page.next_cursor;
    }
    return created;
  }

  private async notify(tenantId: string, run: Readonly<Record<string, JsonValue>>): Promise<number> {
    const runId = typeof run.id === "string" ? run.id : null;
    const workspaceId = bareId("ws", run.workspace_id);
    if (runId === null || workspaceId === null) {
      this.logger.warn({ tenantId, message: "failed run has no id or workspace; not notified" });
      return 0;
    }
    try {
      return await this.notifications.notifyWorkspaceRolesOnce(["admin", "editor"], `run.failed:${runId}`, {
        tenantId,
        workspaceId,
        eventClass: "workflow",
        severity: "critical",
        title: "A workflow run failed",
        body: "A run stopped with a failure. Open it to see which step failed and what Alter tried.",
        // The web app lives under /app; a link outside it opens nothing.
        deepLink: `/app/runs/${encodeURIComponent(runId)}`,
        sourceService: "platform-api.engine-events",
      });
    } catch (error: unknown) {
      this.logger.error({
        tenantId,
        runId,
        message: "run-failed notification failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
