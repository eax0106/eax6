import { randomUUID } from "node:crypto";
import { TenantIdSchema } from "@alterx/contracts";

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

export type ProjectStatus = "draft" | "active" | "archived";
export type DeploymentStatus = "pending" | "active" | "failed";

export interface Project {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectPage {
  readonly data: readonly Project[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

export interface Deployment {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
}

export interface OrchestrationTransactionLike {
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

type ProjectRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly created_at: string;
  readonly updated_at: string;
};

type DeploymentRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly status: DeploymentStatus;
  readonly created_at: string;
};

function projectFromRow(row: ProjectRow): Project {
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

function deploymentFromRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function requireNonEmpty(field: string, value: string | undefined): void {
  if (value === undefined || value.trim().length === 0) {
    throw new ProjectValidationError(`${field} is required`);
  }
}

/**
 * `projects.tenant_id`/`deployments.tenant_id` are real `uuid`-typed
 * columns (0019_create_projects.sql) -- the real, signed-JWT-derived
 * ActorContext.tenant_id SessionGatewayGuard populates is always
 * `ten_`-prefixed (TenantIdSchema), so it must be stripped before use
 * in raw SQL or `store.withTenant()`. Same real pattern as
 * WorkflowReadService's own `bareTenantUuid()`
 * (workflow-read/workflow-read.service.ts) -- duplicated locally per
 * this repo's own convention.
 */
function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new ProjectValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

/**
 * `projects.workspace_id` is a bare `uuid` column for the same reason
 * `tenant_id` is, and the ActorContext the SessionGatewayGuard populates
 * carries the `ws_`-prefixed form. Same shape as WorkflowReadService's own
 * `bareWorkspaceUuid()`, duplicated locally per this repo's convention.
 */
function bareWorkspaceUuid(workspaceId: string): string {
  if (
    !/^ws_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      workspaceId,
    )
  ) {
    throw new ProjectValidationError("workspaceId must be a ws_ prefixed UUIDv7");
  }
  return workspaceId.slice("ws_".length);
}

/**
 * Real read/deploy surface over the real, RLS-scoped `projects`/
 * `deployments` tables (0019_create_projects.sql). Neither table had
 * any real schema anywhere in orchestration-service before this --
 * unlike workflows (PLAN-9), no prior migration existed for a
 * "project"/"deployment" resource, so this closes a genuine
 * "route AND storage both don't exist" gap, not just a wiring gap.
 *
 * Deliberately minimal, same discipline as WorkflowReadService: real
 * tenant-scoped read (getProject) and a real deploy action that creates
 * a real, tenant-scoped `deployments` row (createDeployment) -- no
 * builds/tests/previews/audit-results/versions/rollback, all of which
 * are real, larger production-feature scope platform-api's own
 * ProjectOperationsController already models on its side. This closes
 * exactly what the project_get/project_deploy tenant-isolation cases
 * and the "route doesn't exist" gap need.
 */
export class ProjectReadService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async getProject(tenantId: string, projectId: string): Promise<Project> {
    requireNonEmpty("tenantId", tenantId);
    requireNonEmpty("projectId", projectId);
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<ProjectRow>(
        `SELECT id, tenant_id, workspace_id, name, status, created_at, updated_at
         FROM projects WHERE tenant_id = $1 AND id = $2`,
        [bareTenant, projectId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ProjectNotFoundError(projectId);
      }
      return projectFromRow(row);
    });
  }

  /**
   * Workspace-scoped, same shape and keyset as WorkflowReadService's own
   * listWorkflows: RLS scopes the read to the tenant, and the explicit
   * workspace_id predicate keeps one workspace's projects out of another's
   * list inside that tenant. Ordered by id, which is a UUIDv7 and therefore
   * already in creation order, so the cursor is just the last id returned.
   */
  async listProjects(
    tenantId: string,
    workspaceId: string,
    cursor: string | undefined,
    limit: number,
    query?: string,
  ): Promise<ProjectPage> {
    requireNonEmpty("tenantId", tenantId);
    requireNonEmpty("workspaceId", workspaceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ProjectValidationError("limit must be an integer from 1 to 200");
    }
    if (cursor !== undefined && !cursor.startsWith("prj_")) {
      throw new ProjectValidationError("cursor must be a project ID");
    }
    const nameQuery = query === undefined ? null : query.trim();
    if (nameQuery !== null && (nameQuery.length === 0 || nameQuery.length > 200)) {
      throw new ProjectValidationError("q must be 1 to 200 characters");
    }
    const bareTenant = bareTenantUuid(tenantId);
    const bareWorkspace = bareWorkspaceUuid(workspaceId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<ProjectRow>(
        `SELECT id, tenant_id, workspace_id, name, status, created_at, updated_at
         FROM projects
         WHERE tenant_id = $1 AND workspace_id = $2
           AND ($3::text IS NULL OR id > $3)
           AND ($5::text IS NULL OR name ILIKE '%' || $5 || '%' ESCAPE '\\')
         ORDER BY id
         LIMIT $4`,
        [bareTenant, bareWorkspace, cursor ?? null, limit + 1, nameQuery === null ? null : escapeLike(nameQuery)],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return {
        data: rows.map(projectFromRow),
        page: {
          next_cursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
          has_more: hasMore,
          limit,
        },
      };
    });
  }

  async createDeployment(tenantId: string, projectId: string): Promise<Deployment> {
    requireNonEmpty("tenantId", tenantId);
    requireNonEmpty("projectId", projectId);
    const bareTenant = bareTenantUuid(tenantId);
    return this.store.withTenant(bareTenant, async (tx) => {
      const existing = await tx.query<ProjectRow>(
        `SELECT id FROM projects WHERE tenant_id = $1 AND id = $2`,
        [bareTenant, projectId],
      );
      if (existing.rows[0] === undefined) {
        throw new ProjectNotFoundError(projectId);
      }
      const deploymentId = `dep_${randomUUID()}`;
      const result = await tx.query<DeploymentRow>(
        `INSERT INTO deployments (id, tenant_id, project_id, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, tenant_id, project_id, status, created_at`,
        [deploymentId, bareTenant, projectId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ProjectValidationError("deployment insert returned no row");
      }
      return deploymentFromRow(row);
    });
  }
}

/** A name search is literal: %, _ and \ in what the person typed match themselves. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
