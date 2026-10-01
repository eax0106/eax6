import { createHash } from "node:crypto";
import { EventIdSchema, TenantIdSchema, WorkspaceIdSchema, hasExternalSideEffect, type CompiledDag } from "@alterx/contracts";
import type { OrchestrationTransactionLike, RunLauncherService } from "../runs/run-launcher.service";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { serializeValue } from "../blackboard/blackboard.service";
import type { JsonValue } from "@alterx/shared-clients";
import { EventNotFoundError, EventValidationError, type OrchestrationTenantStore } from "./event-query.service";

export interface ReplayActor {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
}

export interface ReplayEvent extends Record<string, unknown> {
  readonly event_id: string;
  readonly workspace_id: string;
  readonly workflow_id: string;
  readonly payload_inline: Record<string, unknown>;
}

export class ReplayConfirmationError extends Error {
  constructor() { super("Preview the event again and confirm the listed outside actions before replaying for real"); }
}

export function replayActions(dag: CompiledDag) {
  return dag.nodes.filter(node => node.type === "ToolCall" && typeof node.config["tool_name"] === "string" &&
    hasExternalSideEffect(node.config["tool_name"])).map(node => ({ nodeKey: node.key, toolName: String(node.config["tool_name"]) }));
}

export function replayToken(actor: ReplayActor, event: ReplayEvent, versionId: string, dag: CompiledDag): string {
  return createHash("sha256").update(JSON.stringify({ actor, eventId: event.event_id, payload: event.payload_inline,
    workflowId: event.workflow_id, versionId, dag })).digest("hex");
}

export async function storedReplayEvent(tx: OrchestrationTransactionLike, actor: ReplayActor, eventId: string, lock = false): Promise<ReplayEvent> {
  if (!EventIdSchema.safeParse(eventId).success || !TenantIdSchema.safeParse(actor.tenantId).success ||
      !WorkspaceIdSchema.safeParse(actor.workspaceId).success || !/^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor.userId)) {
    throw new EventValidationError("Replay requires valid event and authenticated caller ids");
  }
  const result = await tx.query<ReplayEvent>(
    `SELECT e.event_id, e.workspace_id, e.payload AS payload_inline, t.workflow_id FROM events e
     LEFT JOIN triggers t ON t.tenant_id = e.tenant_id AND t.id = e.trigger_id AND t.workspace_id = e.workspace_id
     WHERE e.tenant_id = $1 AND e.workspace_id = $2 AND e.event_id = $3${lock ? " FOR UPDATE OF e" : ""}`,
    [actor.tenantId.slice(4), actor.workspaceId.slice(3), eventId]);
  const row = result.rows[0];
  if (!row) throw new EventNotFoundError(eventId);
  if (!row.workflow_id) throw new EventValidationError("This stored event has no matched workflow to replay");
  if (row.payload_inline === null || typeof row.payload_inline !== "object" || Array.isArray(row.payload_inline)) {
    throw new EventValidationError("This event has no inline stored payload available for replay");
  }
  serializeValue(row.payload_inline as JsonValue);
  return row;
}

export class EventReplayService {
  constructor(private readonly store: OrchestrationTenantStore, private readonly launcher: RunLauncherService) {}

  async preview(actor: ReplayActor, eventId: string) {
    const event = await this.store.withTenant(actor.tenantId.slice(4), tx => storedReplayEvent(tx, actor, eventId));
    const version = await this.launcher.previewRun(actor.tenantId, event.workflow_id);
    const simulation = await new WorkflowReadService(this.store).simulateWorkflow(actor.tenantId, event.workflow_id,
      event.payload_inline, version.compiledDag);
    return { mode: "dry_run" as const, eventId, workflowId: event.workflow_id, workflowVersionId: version.workflowVersionId,
      payload: event.payload_inline, trace: simulation.trace, actions: replayActions(version.compiledDag),
      confirmationToken: replayToken(actor, event, version.workflowVersionId, version.compiledDag) };
  }

  async replay(actor: ReplayActor, eventId: string, body: unknown, requestKey: string | undefined) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["confirmed", "confirmationToken"].includes(key))) {
      throw new EventValidationError("Replay requires only confirmed and confirmationToken");
    }
    const input = body as Record<string, unknown>;
    if (input["confirmed"] !== true || typeof input["confirmationToken"] !== "string" || !/^[0-9a-f]{64}$/.test(input["confirmationToken"])) {
      throw new ReplayConfirmationError();
    }
    if (!requestKey || !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) throw new EventValidationError("A valid Idempotency-Key is required");
    const event = await this.store.withTenant(actor.tenantId.slice(4), tx => storedReplayEvent(tx, actor, eventId));
    const run = await this.launcher.createRun(actor.tenantId, event.workflow_id, undefined, eventId,
      { replay: { actor, eventId, confirmationToken: input["confirmationToken"], requestKey } });
    return { runId: run.id, replayedFrom: eventId };
  }
}
