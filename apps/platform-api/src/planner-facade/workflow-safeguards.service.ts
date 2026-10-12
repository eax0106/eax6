import type { AuditEventHandler } from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import { z } from "zod";
import { computeEtag, ConcurrencyHttpError, ifMatchIncludes } from "../concurrency";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { PlatformHttpError } from "../signup/problem";
import { WorkspaceSafeguardsSchema, type WorkspaceSafeguards } from "../workspaces/workspace-safeguards.service";

/**
 * Safeguards one workflow adds on top of its workspace's. true adds the
 * safeguard; false adds nothing -- it never removes one the workspace requires.
 * All three are required on write, as with the workspace's own safeguards.
 */
export const WorkflowSafeguardAdditionsSchema = z
  .object({
    // Someone outside the team sees the result: delivered output is verified
    // and approved, and every action that may have side effects is approved.
    customer_visible: z.boolean(),
    contains_pii: z.boolean(),
    approve_external_actions: z.boolean(),
  })
  .strict();

export type WorkflowSafeguardAdditions = z.infer<typeof WorkflowSafeguardAdditionsSchema>;

export const WorkflowSafeguardsBodySchema = z
  .object({ additions: WorkflowSafeguardAdditionsSchema })
  .strict();

export interface WorkflowSafeguardsView {
  /** What the workspace requires; the workflow cannot turn these off. */
  workspace: WorkspaceSafeguards;
  additions: WorkflowSafeguardAdditions;
  /** What every plan of this workflow runs with: workspace OR additions. */
  effective: WorkflowSafeguardAdditions;
}

const NO_ADDITIONS: WorkflowSafeguardAdditions = {
  customer_visible: false,
  contains_pii: false,
  approve_external_actions: false,
};

const WORKFLOW_ID = /^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class WorkflowSafeguardsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSafeguardsError";
  }
}

export function effectiveSafeguards(
  workspace: WorkspaceSafeguards,
  additions: WorkflowSafeguardAdditions,
): WorkflowSafeguardAdditions {
  return {
    customer_visible: additions.customer_visible,
    contains_pii: workspace.contains_pii || additions.contains_pii,
    approve_external_actions: workspace.approve_external_actions || additions.approve_external_actions,
  };
}

export class WorkflowSafeguardsService {
  constructor(
    private readonly db: PlatformDb,
    private readonly audit: AuditEventHandler,
  ) {}

  async get(actor: ActorContext, workflowId: string): Promise<WorkflowSafeguardsView> {
    const scope = requestScope(actor, workflowId);
    return this.db.withTenant(scope.tenantId, async (client) =>
      read(client, scope, false, () => workflowNotFound(scope.instance)),
    );
  }

  /**
   * The safeguards a plan of this workflow must run with. Fails closed: a
   * missing workspace or a stored value the schema rejects throws rather than
   * planning with fewer safeguards than the workspace requires.
   */
  async effectiveFor(tenantId: string, workspaceId: string, workflowId: string): Promise<WorkflowSafeguardAdditions> {
    const scope = {
      tenantId: bare("ten", tenantId),
      workspaceId: bare("ws", workspaceId),
      workflowId,
      instance: safeguardsInstance(workflowId),
    };
    const view = await this.db.withTenant(scope.tenantId, async (client) =>
      read(client, scope, false, (message) => {
        throw new WorkflowSafeguardsError(message);
      }),
    );
    return view.effective;
  }

  /**
   * Replaces the workflow's additions. The If-Match check covers the whole
   * view, workspace safeguards included, so a caller who saw an older
   * workspace rule is told to reload. The check, the write and the audit
   * event share one transaction with both rows locked.
   */
  async set(
    actor: ActorContext,
    workflowId: string,
    body: unknown,
    ifMatch: string | undefined,
  ): Promise<WorkflowSafeguardsView> {
    const scope = requestScope(actor, workflowId);
    const parsed = WorkflowSafeguardsBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new PlatformHttpError(
        400,
        "INVALID_SAFEGUARDS",
        "Body must be { additions: { customer_visible: boolean, contains_pii: boolean, approve_external_actions: boolean } }",
        scope.instance,
        parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      );
    }
    if (!ifMatch) {
      throw new ConcurrencyHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", scope.instance);
    }
    return this.db.withTenant(scope.tenantId, async (client) => {
      const before = await read(client, scope, true, () => workflowNotFound(scope.instance));
      if (!ifMatchIncludes(ifMatch, computeEtag(before))) {
        throw new ConcurrencyHttpError(412, "ETAG_MISMATCH", "Resource changed since it was read", scope.instance);
      }
      const additions = parsed.data.additions;
      // Two first writers find no additions row to lock, so the workspace row
      // lock is what serialises them: the second reads only after the first
      // commits, sees its row and fails If-Match. ON CONFLICT is a backstop.
      await client.query(
        `INSERT INTO workflow_safeguards (tenant_id, workspace_id, workflow_id, additions)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, workflow_id)
         DO UPDATE SET additions = EXCLUDED.additions, updated_at = now()
         WHERE workflow_safeguards.workspace_id = EXCLUDED.workspace_id`,
        [scope.tenantId, scope.workspaceId, scope.workflowId, JSON.stringify(additions)],
      );
      await this.audit.recordEvent({
        tenant_id: scope.tenantId,
        actor_type: "user",
        actor_ref: actor.user_id,
        action: "workflow.safeguards.update",
        target_type: "workflow",
        target_ref: scope.workflowId,
        result: "success",
        reason_code: "",
        context_json: JSON.stringify({ scope: { before: before.additions, after: additions } }),
        occurred_at: new Date().toISOString(),
      });
      return { workspace: before.workspace, additions, effective: effectiveSafeguards(before.workspace, additions) };
    });
  }
}

interface Scope {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly instance: string;
}

async function read(
  client: PoolClient,
  scope: Scope,
  lock: boolean,
  missing: (message: string) => never,
): Promise<WorkflowSafeguardsView> {
  // A write locks the workspace row, not just the additions row: a workflow's
  // first write has no additions row to lock, and FOR SHARE would let two
  // first writers through together. Writes are rare; serialising them per
  // workspace costs nothing noticeable.
  const workspaceRow = await client.query<{ safeguards: unknown }>(
    `SELECT safeguards FROM workspaces WHERE id = $1 AND tenant_id = $2${lock ? " FOR UPDATE" : ""}`,
    [scope.workspaceId, scope.tenantId],
  );
  if (workspaceRow.rows[0] === undefined) missing("workspace not found");
  const workspace = WorkspaceSafeguardsSchema.safeParse(workspaceRow.rows[0].safeguards);
  if (!workspace.success) malformed(scope.instance, "workspace safeguards are malformed");

  const additionsRow = await client.query<{ workspace_id: string; additions: unknown }>(
    `SELECT workspace_id, additions FROM workflow_safeguards WHERE tenant_id = $1 AND workflow_id = $2${lock ? " FOR UPDATE" : ""}`,
    [scope.tenantId, scope.workflowId],
  );
  const row = additionsRow.rows[0];
  // A workflow belongs to one workspace; its additions are invisible from any other.
  if (row !== undefined && row.workspace_id !== scope.workspaceId) missing("workflow not found");
  const additions = row === undefined ? { success: true as const, data: NO_ADDITIONS } : WorkflowSafeguardAdditionsSchema.safeParse(row.additions);
  if (!additions.success) malformed(scope.instance, "workflow safeguards are malformed");

  return {
    workspace: workspace.data,
    additions: additions.data,
    effective: effectiveSafeguards(workspace.data, additions.data),
  };
}

function requestScope(actor: ActorContext, workflowId: string): Scope {
  const instance = safeguardsInstance(workflowId);
  if (!WORKFLOW_ID.test(workflowId) || !actor.workspace_id) workflowNotFound(instance);
  return {
    tenantId: bare("ten", actor.tenant_id),
    workspaceId: bare("ws", actor.workspace_id),
    workflowId,
    instance,
  };
}

function workflowNotFound(instance: string): never {
  throw new PlatformHttpError(404, "WORKFLOW_NOT_FOUND", "Workflow not found", instance);
}

function malformed(instance: string, detail: string): never {
  throw new PlatformHttpError(500, "SAFEGUARDS_MALFORMED", detail, instance);
}

function safeguardsInstance(workflowId: string): string {
  return `/api/v1/workflows/${workflowId}/safeguards`;
}

// ActorContext and the Engine carry prefixed ids; platform tables hold the bare UUID.
function bare(prefix: "ten" | "ws", id: string): string {
  return id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : id;
}
