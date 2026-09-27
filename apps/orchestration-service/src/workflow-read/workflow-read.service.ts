import { CompiledDagSchema, TenantIdSchema, WorkflowIdSchema } from "@alterx/contracts";
import { randomUUID } from "node:crypto";

export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Workflow ${workflowId} was not found`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export type WorkflowStatus = "draft" | "active" | "archived" | "paused";

export interface Workflow {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateWorkflowRequest {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly name?: string;
  readonly status?: WorkflowStatus;
  readonly dag?: unknown;
}

export interface CreateWorkflowRequest {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly name: string;
}

export interface WorkflowPage {
  readonly data: readonly Workflow[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

/**
 * A page of versions for the Deployment Manager. The rows carry the
 * deployment-shaped fields the screen reads (traffic share, evaluation
 * result) on top of WorkflowVersion, and leave out the compiled DAG, which
 * is large and which nothing in a list renders.
 */
export interface WorkflowVersionSummary
  extends Omit<WorkflowVersion, "compiledDag" | "tenantId"> {
  readonly trafficPercent: number | null;
  readonly evaluationRunId: string | null;
  readonly testedAt: string | null;
  readonly evaluationFailedAt: string | null;
}

export interface WorkflowVersionPage {
  readonly data: readonly WorkflowVersionSummary[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface OrchestrationTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (tx: OrchestrationTransactionLike) => Promise<T>,
  ): Promise<T>;
}

type WorkflowRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly created_at: string;
  readonly updated_at: string;
};

type WorkflowVersionSummaryRow = {
  readonly id: string;
  readonly workflow_id: string;
  readonly version: number;
  readonly status: WorkflowVersionStatus;
  readonly dag_schema_version: string;
  readonly traffic_percent: number | null;
  readonly evaluation_run_id: string | null;
  readonly tested_at: string | null;
  readonly evaluation_failed_at: string | null;
  readonly created_at: string;
};

function versionSummaryFromRow(row: WorkflowVersionSummaryRow): WorkflowVersionSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    status: row.status,
    dagSchemaVersion: row.dag_schema_version,
    trafficPercent: row.traffic_percent,
    evaluationRunId: row.evaluation_run_id,
    testedAt: row.tested_at,
    evaluationFailedAt: row.evaluation_failed_at,
    createdAt: row.created_at,
  };
}

function fromRow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireNonEmpty(field: string, value: string | undefined): void {
  if (value === undefined || value.trim().length === 0) {
    throw new WorkflowValidationError(`${field} is required`);
  }
}

/**
 * `workflows.tenant_id` is a real `uuid`-typed column
 * (0000_create_workflows.sql) -- the real, signed-JWT-derived
 * ActorContext.tenant_id SessionGatewayGuard populates is always
 * `ten_`-prefixed (TenantIdSchema), so it must be stripped before use in
 * raw SQL or `store.withTenant()`. Same real pattern as
 * NodeExecutionLedgerService's own `bareTenantUuid()`
 * (runs/node-execution-ledger.service.ts) -- duplicated locally per this
 * repo's own convention (each module keeps its own copy, not a shared
 * helper).
 */
function bareTenantUuid(tenantId: string): string {

  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {

    throw new WorkflowValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function bareWorkspaceUuid(workspaceId: string): string {
  if (!/^ws_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(workspaceId)) {
    throw new WorkflowValidationError("workspaceId must be a ws_ prefixed UUIDv7");
  }
  return workspaceId.slice("ws_".length);
}

function newWorkflowId(): `wf_${string}` {
  const uuid = randomUUID();
  return `wf_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

/**
 * Real read/update surface over the real, RLS-scoped `workflows` table
 * (0000_create_workflows.sql -- ENABLE+FORCE RLS, `workflows_tenant_id_id_
 * unique` constraint, `workflows_tenant_context_isolation` policy keyed off
 * `app.current_tenant_id`). This table has existed since Planning (PLAN-9)
 * but had zero real reader/writer anywhere in the codebase until now --
 * platform-api's WorkflowController/WorkflowService (GET/PATCH /api/v1/
 * workflows/:id) called an orchestration-service route that never existed.
 *
 * Deliberately minimal: no etag/If-Match concurrency control, no canvas
 * body, no versions/validate/compile/simulate/activate/pause/resume --
 * those are real, larger production-feature scope (platform-api's own
 * WorkflowController already has real etag handling on its side; wiring
 * that through end-to-end is a disclosed, separate follow-up). This closes
 * exactly what the workflow_get/workflow_update tenant-isolation cases and
 * a genuine "does this route exist" gap need: real tenant-scoped read and
 * a real name/status update, both real RLS-enforced, both real 404s for
 * any row outside the caller's own tenant.
 */
export class WorkflowReadService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async createWorkflow(request: CreateWorkflowRequest): Promise<Workflow> {
    requireNonEmpty("tenantId", request.tenantId);
    requireNonEmpty("workspaceId", request.workspaceId);
    requireNonEmpty("name", request.name);
    const bareTenant = bareTenantUuid(request.tenantId);
    const bareWorkspace = bareWorkspaceUuid(request.workspaceId);
    const workflowId = newWorkflowId();
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<WorkflowRow>(
        `INSERT INTO workflows (id, tenant_id, workspace_id, name, status)
         VALUES ($1, $2, $3, $4, 'draft')
         RETURNING id, tenant_id, workspace_id, name, status, created_at, updated_at`,
        [workflowId, bareTenant, bareWorkspace, request.name.trim()],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new WorkflowValidationError("workflow insert returned no row");
      }
      return fromRow(row);
    });
  }

  async getWorkflow(tenantId: string, workflowId: string): Promise<Workflow> {
    requireNonEmpty("tenantId", tenantId);
    requireNonEmpty("workflowId", workflowId);
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<WorkflowRow>(
        `SELECT id, tenant_id, workspace_id, name, status, created_at, updated_at
         FROM workflows WHERE tenant_id = $1 AND id = $2`,
        [bareTenant, workflowId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new WorkflowNotFoundError(workflowId);
      }
      return fromRow(row);
    });
  }

  async listWorkflows(
    tenantId: string,
    workspaceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<WorkflowPage> {
    requireNonEmpty("tenantId", tenantId);
    requireNonEmpty("workspaceId", workspaceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new WorkflowValidationError("limit must be an integer from 1 to 200");
    }
    if (cursor !== undefined && !WorkflowIdSchema.safeParse(cursor).success) {
      throw new WorkflowValidationError("cursor must be a workflow ID");
    }
    const bareTenant = bareTenantUuid(tenantId);
    const bareWorkspace = bareWorkspaceUuid(workspaceId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<WorkflowRow>(
        `SELECT id, tenant_id, workspace_id, name, status, created_at, updated_at
         FROM workflows
         WHERE tenant_id = $1 AND workspace_id = $2
           AND ($3::text IS NULL OR id > $3)
         ORDER BY id
         LIMIT $4`,
        [bareTenant, bareWorkspace, cursor ?? null, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return {
        data: rows.map(fromRow),
        page: {
          next_cursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
          has_more: hasMore,
          limit,
        },
      };
    });
  }

  /**
   * The versions of one workflow, newest first, which is the order a person
   * reads a deployment history in -- unlike listWorkflows, whose cursor is an
   * id because its order is arbitrary. Version numbers are unique per
   * workflow and monotonic, so paging on the number needs no tiebreak.
   *
   * platform-api has proxied GET /api/v1/workflows/:id/versions to this
   * service since it was written; the route simply never existed here, so
   * every call reached an engine 404.
   */
  async listVersions(
    tenantId: string,
    workflowId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<WorkflowVersionPage> {
    requireNonEmpty("tenantId", tenantId);
    requireNonEmpty("workflowId", workflowId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new WorkflowValidationError("limit must be an integer from 1 to 200");
    }
    const cursorVersion = cursor === undefined ? undefined : Number(cursor);
    if (
      cursorVersion !== undefined &&
      (!Number.isInteger(cursorVersion) || cursorVersion < 1)
    ) {
      throw new WorkflowValidationError("cursor must be a version number");
    }
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<WorkflowVersionSummaryRow>(
        `SELECT id, workflow_id, version, status, dag_schema_version, traffic_percent,
                evaluation_run_id, tested_at, evaluation_failed_at, created_at
         FROM workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2
           AND ($3::int IS NULL OR version < $3)
         ORDER BY version DESC
         LIMIT $4`,
        [bareTenant, workflowId, cursorVersion ?? null, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return {
        data: rows.map(versionSummaryFromRow),
        page: {
          next_cursor: hasMore ? String(rows.at(-1)?.version ?? "") : null,
          has_more: hasMore,
          limit,
        },
      };
    });
  }

  async updateWorkflow(request: UpdateWorkflowRequest): Promise<Workflow> {
    requireNonEmpty("tenantId", request.tenantId);
    requireNonEmpty("workflowId", request.workflowId);
    if (request.name !== undefined) {
      requireNonEmpty("name", request.name);
    }
    if (request.status !== undefined && !["draft", "active", "archived", "paused"].includes(request.status)) {
      throw new WorkflowValidationError("status must be one of draft, active, archived, paused");
    }
    if (request.dag !== undefined) {
      const parsed = CompiledDagSchema.safeParse(request.dag);
      if (!parsed.success) {
        throw new WorkflowValidationError(
          `dag is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
    }
    const bareTenant = bareTenantUuid(request.tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<WorkflowRow>(
        `UPDATE workflows
         SET name = COALESCE($3, name),
             status = COALESCE($4, status),
             draft_dag = COALESCE($5::jsonb, draft_dag),
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, tenant_id, workspace_id, name, status, created_at, updated_at`,
        [
          bareTenant,
          request.workflowId,
          request.name ?? null,
          request.status ?? null,
          request.dag === undefined ? null : JSON.stringify(request.dag),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new WorkflowNotFoundError(request.workflowId);
      }
      return fromRow(row);
    });
  }

  async validateDraft(tenantId: string, workflowId: string): Promise<{ readonly valid: boolean; readonly errors: readonly string[] }> {
    const draftDag = await this.#requireDraftDag(tenantId, workflowId);
    const parsed = CompiledDagSchema.safeParse(draftDag);
    return {
      valid: parsed.success,
      errors: parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  async compileWorkflow(tenantId: string, workflowId: string): Promise<WorkflowVersion> {
    const draftDag = await this.#requireDraftDag(tenantId, workflowId);
    const parsed = CompiledDagSchema.safeParse(draftDag);
    if (!parsed.success) {
      throw new WorkflowValidationError(
        `Cannot compile an invalid dag: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const nextVersionResult = await tx.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM workflow_versions WHERE tenant_id = $1 AND workflow_id = $2`,
        [bareTenant, workflowId],
      );
      const nextVersion = nextVersionResult.rows[0]?.next ?? 1;
      const versionId = newWorkflowVersionId();
      const result = await tx.query<WorkflowVersionRow>(
        `INSERT INTO workflow_versions (id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'compiled')
         RETURNING id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, status, created_at`,
        [versionId, bareTenant, workflowId, nextVersion, JSON.stringify(parsed.data), parsed.data.schema_version],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new WorkflowValidationError("workflow_versions insert returned no row");
      }
      return fromVersionRow(row);
    });
  }

  async activateWorkflow(tenantId: string, workflowId: string): Promise<WorkflowVersion> {
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const latest = await tx.query<WorkflowVersionRow>(
        `SELECT id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, status, created_at
         FROM workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2 AND status IN ('compiled', 'promoted')
         ORDER BY version DESC LIMIT 1`,
        [bareTenant, workflowId],
      );
      const row = latest.rows[0];
      if (row === undefined) {
        throw new WorkflowValidationError("No compiled version to activate -- run compile first");
      }
      await tx.query(
        `UPDATE workflow_versions SET status = 'retired'
         WHERE tenant_id = $1 AND workflow_id = $2 AND status = 'promoted' AND id != $3`,
        [bareTenant, workflowId, row.id],
      );
      const promoted = await tx.query<WorkflowVersionRow>(
        `UPDATE workflow_versions SET status = 'promoted' WHERE tenant_id = $1 AND id = $2
         RETURNING id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, status, created_at`,
        [bareTenant, row.id],
      );
      await tx.query(
        `UPDATE workflows SET status = 'active', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [bareTenant, workflowId],
      );
      const promotedRow = promoted.rows[0];
      if (promotedRow === undefined) {
        throw new WorkflowValidationError("workflow_versions update returned no row");
      }
      return fromVersionRow(promotedRow);
    });
  }

  async pauseWorkflow(tenantId: string, workflowId: string): Promise<Workflow> {
    return this.#transitionStatus(tenantId, workflowId, "active", "paused");
  }

  async resumeWorkflow(tenantId: string, workflowId: string): Promise<Workflow> {
    return this.#transitionStatus(tenantId, workflowId, "paused", "active");
  }

  async simulateWorkflow(
    tenantId: string,
    workflowId: string,
    input: Record<string, unknown>,
  ): Promise<{ readonly trace: readonly { key: string; type: string; status: "simulated"; input: Record<string, unknown> }[] }> {
    const draftDag = await this.#requireDraftDag(tenantId, workflowId);
    const parsed = CompiledDagSchema.safeParse(draftDag);
    if (!parsed.success) {
      throw new WorkflowValidationError(
        `Cannot simulate an invalid dag: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    // Structural dry-run only: walks nodes in wave order and echoes the
    // simulated input at each step. Does not call real LLMs/tools -- that
    // needs model-gateway/tool-gateway wiring, a separate, larger scope.
    const nodesByKey = new Map(parsed.data.nodes.map((node) => [node.key, node]));
    const trace = parsed.data.waves
      .slice()
      .sort((a, b) => a.order - b.order)
      .flatMap((wave) =>
        wave.node_keys.map((key) => {
          const node = nodesByKey.get(key);
          return {
            key,
            type: node?.type ?? "unknown",
            status: "simulated" as const,
            input,
          };
        }),
      );
    return { trace };
  }

  async #requireDraftDag(tenantId: string, workflowId: string): Promise<unknown> {
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<{ draft_dag: unknown }>(
        `SELECT draft_dag FROM workflows WHERE tenant_id = $1 AND id = $2`,
        [bareTenant, workflowId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new WorkflowNotFoundError(workflowId);
      }
      if (row.draft_dag === null || row.draft_dag === undefined) {
        throw new WorkflowValidationError("Workflow has no saved canvas to validate -- save the builder canvas first");
      }
      return row.draft_dag;
    });
  }

  async #transitionStatus(
    tenantId: string,
    workflowId: string,
    from: WorkflowStatus,
    to: WorkflowStatus,
  ): Promise<Workflow> {
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<WorkflowRow>(
        `UPDATE workflows SET status = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = $3
         RETURNING id, tenant_id, workspace_id, name, status, created_at, updated_at`,
        [bareTenant, workflowId, from, to],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const exists = await tx.query<{ id: string }>(
          `SELECT id FROM workflows WHERE tenant_id = $1 AND id = $2`,
          [bareTenant, workflowId],
        );
        if (exists.rows[0] === undefined) {
          throw new WorkflowNotFoundError(workflowId);
        }
        throw new WorkflowValidationError(`Workflow must be "${from}" to transition to "${to}"`);
      }
      return fromRow(row);
    });
  }
}

// "tested" has been a real status since 0035 added the test gate, and
// WorkflowLifecycleService writes it; this union had never caught up, so a
// tested version typed as something it is not.
export type WorkflowVersionStatus =
  | "compiled"
  | "tested"
  | "canary"
  | "promoted"
  | "rolled_back"
  | "retired";

export interface WorkflowVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly version: number;
  readonly compiledDag: unknown;
  readonly dagSchemaVersion: string;
  readonly status: WorkflowVersionStatus;
  readonly createdAt: string;
}

type WorkflowVersionRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly workflow_id: string;
  readonly version: number;
  readonly compiled_dag: unknown;
  readonly dag_schema_version: string;
  readonly status: WorkflowVersionStatus;
  readonly created_at: string;
};

function fromVersionRow(row: WorkflowVersionRow): WorkflowVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    version: row.version,
    compiledDag: row.compiled_dag,
    dagSchemaVersion: row.dag_schema_version,
    status: row.status,
    createdAt: row.created_at,
  };
}

function newWorkflowVersionId(): `wfv_${string}` {
  const uuid = randomUUID();
  return `wfv_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}
