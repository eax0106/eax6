import type { AuditEventHandler } from "@alterx/shared-clients";
import { z } from "zod";
import { computeEtag, ConcurrencyHttpError, ifMatchIncludes } from "../concurrency";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { PlatformHttpError } from "../signup/problem";
import { bareWorkspaceId } from "./workspace-id";

/**
 * The safeguards a workspace requires on every run, set by a tenant owner.
 * Both fields are required on write: a partial body could otherwise switch a
 * rule off by leaving it out. Migration 0019 enforces the same shape.
 */
export const WorkspaceSafeguardsSchema = z
  .object({
    // The workspace's runs handle personal data; delivered output is verified.
    contains_pii: z.boolean(),
    // A person approves every action that may send or change something outside Alter.
    approve_external_actions: z.boolean(),
  })
  .strict();

export type WorkspaceSafeguards = z.infer<typeof WorkspaceSafeguardsSchema>;

export interface WorkspaceSafeguardsView {
  safeguards: WorkspaceSafeguards;
}

export const WorkspaceSafeguardsBodySchema = z
  .object({ safeguards: WorkspaceSafeguardsSchema })
  .strict();

export class WorkspaceSafeguardsService {
  constructor(
    private readonly db: PlatformDb,
    private readonly audit: AuditEventHandler,
  ) {}

  async get(actor: ActorContext, workspaceId: string): Promise<WorkspaceSafeguardsView> {
    const instance = safeguardsInstance(workspaceId);
    const rows = await this.db.queryTenant<{ safeguards: unknown }>(
      actor.tenant_id,
      "SELECT safeguards FROM workspaces WHERE id = $1 AND tenant_id = $2",
      [uuidOrNotFound(workspaceId, instance), actor.tenant_id],
    );
    return view(rows[0] ?? workspaceNotFound(instance), instance);
  }

  /**
   * Replaces the workspace's safeguards. The If-Match check, the write and the
   * audit event share one transaction with the row locked, so a concurrent
   * owner cannot slip between the check and the update, and a change the audit
   * service did not record is rolled back rather than kept unaudited.
   */
  async set(
    actor: ActorContext,
    workspaceId: string,
    body: unknown,
    ifMatch: string | undefined,
  ): Promise<WorkspaceSafeguardsView> {
    const instance = safeguardsInstance(workspaceId);
    const id = uuidOrNotFound(workspaceId, instance);
    const parsed = WorkspaceSafeguardsBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new PlatformHttpError(
        400,
        "INVALID_SAFEGUARDS",
        "Body must be { safeguards: { contains_pii: boolean, approve_external_actions: boolean } }",
        instance,
        parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      );
    }
    if (!ifMatch) {
      throw new ConcurrencyHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", instance);
    }
    return this.db.withTenant(actor.tenant_id, async (client) => {
      const current = await client.query<{ safeguards: unknown }>(
        "SELECT safeguards FROM workspaces WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, actor.tenant_id],
      );
      const before = view(current.rows[0] ?? workspaceNotFound(instance), instance);
      if (!ifMatchIncludes(ifMatch, computeEtag(before))) {
        throw new ConcurrencyHttpError(412, "ETAG_MISMATCH", "Resource changed since it was read", instance);
      }
      const after: WorkspaceSafeguardsView = { safeguards: parsed.data.safeguards };
      await client.query("UPDATE workspaces SET safeguards = $3 WHERE id = $1 AND tenant_id = $2", [
        id,
        actor.tenant_id,
        JSON.stringify(after.safeguards),
      ]);
      await this.audit.recordEvent({
        tenant_id: actor.tenant_id,
        actor_type: "user",
        actor_ref: actor.user_id,
        action: "workspace.safeguards.update",
        target_type: "workspace",
        target_ref: id,
        result: "success",
        reason_code: "",
        context_json: JSON.stringify({ before: before.safeguards, after: after.safeguards }),
        occurred_at: new Date().toISOString(),
      });
      return after;
    });
  }
}

function view(row: { safeguards: unknown }, instance: string): WorkspaceSafeguardsView {
  // Fails closed: a stored value the schema rejects is an error, never read as
  // "no safeguards".
  const parsed = WorkspaceSafeguardsSchema.safeParse(row.safeguards);
  if (!parsed.success) {
    throw new PlatformHttpError(500, "SAFEGUARDS_MALFORMED", "Stored workspace safeguards are malformed", instance);
  }
  return { safeguards: parsed.data };
}

function safeguardsInstance(workspaceId: string): string {
  return `/api/v1/workspaces/${workspaceId}/safeguards`;
}

/** A malformed id is a workspace that does not exist, not a database error. */
function uuidOrNotFound(workspaceId: string, instance: string): string {
  return bareWorkspaceId(workspaceId) ?? workspaceNotFound(instance);
}

function workspaceNotFound(instance: string): never {
  throw new PlatformHttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found", instance);
}
