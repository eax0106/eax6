import { Injectable, Logger } from "@nestjs/common";
import type { JsonValue } from "@alterx/shared-clients";
import { EngineClient } from "../../engine";
import { NotificationService } from "../notification.service";
import { bareId, type EngineEventProducer, type EngineEventProducerContext } from "./engine-event-producer";

const LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** Announces a newly live or restored version without changing the workflow. */
@Injectable()
export class DeploymentChangedProducer implements EngineEventProducer {
  readonly name = "deployment-changed";
  private readonly logger = new Logger(DeploymentChangedProducer.name);

  constructor(private readonly engine: EngineClient, private readonly notifications: NotificationService) {}

  async produce(context: EngineEventProducerContext): Promise<number> {
    const changedAfter = new Date(context.now.getTime() - LOOKBACK_MS).toISOString();
    const response = await this.engine.get<{ readonly data: readonly Readonly<Record<string, JsonValue>>[] }>(
      `/api/v1/deployment-changes?changed_after=${encodeURIComponent(changedAfter)}`, context.caller,
    );
    let created = 0;
    for (const change of response.body.data) {
      const workspaceId = bareId("ws", change.workspace_id);
      const workflowId = change.workflow_id;
      const versionId = change.workflow_version_id;
      const version = change.version;
      const kind = change.kind;
      if (!workspaceId || typeof workflowId !== "string" || !workflowId || typeof versionId !== "string" || !versionId ||
          typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || (kind !== "promoted" && kind !== "restored")) continue;
      try {
        created += await this.notifications.notifyWorkspaceRolesOnce(["admin", "editor"], `deploy:${versionId}:${kind}`, {
          tenantId: context.tenantId, workspaceId, eventClass: "workflow", severity: "info",
          title: "A workflow's live version changed",
          body: kind === "promoted" ? `Version ${version} of this workflow is now live` : `This workflow was rolled back to version ${version}`,
          deepLink: `/app/workflows/${encodeURIComponent(workflowId)}`, sourceService: "platform-api.engine-events",
        });
      } catch (error: unknown) {
        this.logger.error({ tenantId: context.tenantId, workflowId, message: "deployment notification failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return created;
  }
}
