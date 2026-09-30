import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { EngineClient } from "../../engine";
import { createSystemCallerContext } from "../../system-jobs/system-caller";
import { NotificationService } from "../notification.service";
import { bareId } from "./engine-event-producer";

export interface DriftSuggestion {
  readonly tenantId: string;
  readonly agentId: string;
  readonly taskClass: string;
  readonly action: "flagged" | "weight_decay";
}

interface AgentWorkflows {
  readonly data: readonly { readonly workflow_id?: unknown; readonly workspace_id?: unknown; readonly name?: unknown }[];
}

/**
 * Section 17's outbound path: the Drift Detector found an agent doing worse
 * than it used to on a class of task and turned its weight down. Alter does
 * not touch any workflow; it tells the admins and editors of each workflow
 * the agent worked in lately, once a month per agent and task class, and they
 * decide. The workflows are read from the engine as `system:platform-jobs`.
 */
@Injectable()
export class DriftSuggestionRunner {
  private readonly logger = new Logger(DriftSuggestionRunner.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly notifications: NotificationService,
  ) {}

  async run(suggestion: DriftSuggestion, now: Date = new Date()): Promise<number> {
    const tenantId = suggestion.tenantId.slice("ten_".length);
    const caller = createSystemCallerContext({ tenantId, traceparent: newTraceparent() });
    const response = await this.engine.get<AgentWorkflows>(
      `/api/v1/agents/${encodeURIComponent(suggestion.agentId)}/workflows`,
      caller,
    );
    const month = now.toISOString().slice(0, 7);
    let created = 0;
    for (const workflow of response.body.data) {
      const workspaceId = bareId("ws", workflow.workspace_id);
      if (typeof workflow.workflow_id !== "string" || workspaceId === null) continue;
      try {
        created += await this.notifications.notifyWorkspaceRolesOnce(
          ["admin", "editor"],
          `drift:${suggestion.agentId}:${suggestion.taskClass}:${workflow.workflow_id}:${month}`,
          {
            tenantId,
            workspaceId,
            eventClass: "workflow",
            severity: "info",
            title: "A workflow may be worth a look",
            body:
              `An AI agent this workflow uses has been doing worse lately on "${suggestion.taskClass}" tasks, ` +
              "so Alter now picks it less often. Nothing in your workflow was changed; you may want to review its recent runs.",
            deepLink: `/app/workflows/${encodeURIComponent(workflow.workflow_id)}`,
            sourceService: "platform-api.engine-events",
          },
        );
      } catch (error: unknown) {
        this.logger.error({
          tenantId,
          workflowId: workflow.workflow_id,
          message: "drift suggestion notification failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return created;
  }
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
