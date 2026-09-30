import {
  ArtifactIdSchema,
  DeploymentIdSchema,
  ProjectIdSchema,
} from "@alterx/contracts";
import type {
  DeployctlPromoteVersionRequest,
  DeployctlPromoteVersionResponse,
  DeployctlRollbackVersionRequest,
  DeployctlRollbackVersionResponse,
  DeployctlStartCanaryRequest,
  DeployctlStartCanaryResponse,
} from "@alterx/contracts";
import { randomUUID } from "node:crypto";
import type { ObjectStorageProvider } from "@alterx/shared-clients";
import {
  ArtifactNotFoundError,
  type ArtifactsService,
} from "../artifacts/artifacts.service";
import type { EvalFacadeService } from "../eval-facade/eval-facade.service";

const TENANT_ID_PATTERN =
  /^ten_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_ID_PATTERN =
  /^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_VERSION_ID_PATTERN =
  /^wfv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WRITE_ATTEMPTS = 3;

type WorkflowVersionStatus =
  | "compiled"
  | "tested"
  | "canary"
  | "promoted"
  | "rolled_back"
  | "retired";

type TransitionPurpose =
  | "test_version"
  | "start_canary"
  | "promote_target"
  | "retire_current"
  | "rollback_current"
  | "restore_target";

const VALID_TRANSITIONS: Readonly<
  Record<
    TransitionPurpose,
    Readonly<Partial<Record<WorkflowVersionStatus, readonly WorkflowVersionStatus[]>>>
  >
> = {
  // Operation-scoped transitions keep routine promotion separate from
  // rollback restoration: retired versions can return to promoted only as
  // an explicit rollback target, never through promoteVersion.
  test_version: { compiled: ["tested"] },
  start_canary: { tested: ["canary"] },
  promote_target: { canary: ["promoted"] },
  retire_current: { promoted: ["retired"] },
  rollback_current: { promoted: ["rolled_back"] },
  restore_target: { retired: ["promoted"] },
};

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

interface WorkflowRevisionRow extends Record<string, unknown> {
  readonly revision: string;
}

interface WorkflowVersionRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
}

interface PromotedAtRow extends Record<string, unknown> {
  readonly promoted_at: Date | string;
}

type ProjectDeploymentStatus = "pending" | "active" | "failed" | "rolled_back" | "suspended";

interface ProjectDeploymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly artifact_id: string;
  readonly destination_reference: string;
  readonly status: ProjectDeploymentStatus;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface VersionSnapshot {
  readonly target: {
    readonly id: string;
    readonly status: WorkflowVersionStatus;
  };
  readonly currentPromoted?: {
    readonly id: string;
    readonly status: "promoted";
  };
  readonly currentCanary?: {
    readonly id: string;
    readonly status: "canary";
  };
}

export class DeploymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentValidationError";
  }
}

export class DeploymentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentNotFoundError";
  }
}

export class ReleaseGateFailedError extends Error {
  constructor(readonly failedThresholds: readonly string[]) {
    super("Workflow version failed the release evaluation gate");
  }
}

export class DeploymentStateTransitionError extends Error {
  constructor(
    purpose: TransitionPurpose,
    from: WorkflowVersionStatus,
    to: WorkflowVersionStatus,
  ) {
    super(`invalid ${purpose} transition from ${from} to ${to}`);
    this.name = "DeploymentStateTransitionError";
  }
}

export class DeploymentConcurrencyError extends Error {
  constructor(
    resourceId: string,
    reason = "concurrent lifecycle writes did not settle",
    resourceKind: "workflow" | "project" = "workflow",
  ) {
    super(`deployment update failed for ${resourceKind}_id=${resourceId}: ${reason}`);
    this.name = "DeploymentConcurrencyError";
  }
}

export class ProjectDeploymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeploymentConfigurationError";
  }
}

export class ProjectDeploymentStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeploymentStateTransitionError";
  }
}

export interface ProjectArtifactDeploymentRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifactId: string;
}

export interface ProjectArtifactDeployment {
  readonly id: string;
  readonly projectId: string;
  readonly artifactId: string;
  readonly destinationReference: string;
  readonly status: "active";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectArtifactDeploymentDependencies {
  readonly artifacts: Pick<ArtifactsService, "get" | "read">;
  readonly objects: ObjectStorageProvider;
  readonly staticDeploymentBucket: string;
}

class RetryDeploymentWrite extends Error {}

function bareTenantUuid(tenantId: string): string {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new DeploymentValidationError(
      "tenant_id must be a ten_ prefixed UUIDv7",
    );
  }
  return tenantId.slice("ten_".length);
}

function requireWorkflowId(workflowId: string): void {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new DeploymentValidationError(
      "workflow_id must be a wf_ prefixed UUIDv7",
    );
  }
}

function requireWorkflowVersionId(field: string, value: string): void {
  if (!WORKFLOW_VERSION_ID_PATTERN.test(value)) {
    throw new DeploymentValidationError(
      `${field} must be a wfv_ prefixed UUIDv7`,
    );
  }
}

function requireTrafficPercent(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 99) {
    throw new DeploymentValidationError(
      "traffic_percent must be an integer from 1 to 99",
    );
  }
}

function requireProjectId(projectId: string): void {
  if (!ProjectIdSchema.safeParse(projectId).success) {
    throw new DeploymentValidationError(
      "project_id must be a prj_ prefixed UUIDv7",
    );
  }
}

function requireArtifactId(artifactId: string): void {
  if (!ArtifactIdSchema.safeParse(artifactId).success) {
    throw new DeploymentValidationError(
      "artifact_id must be an art_ prefixed UUIDv7",
    );
  }
}

function newDeploymentId(): string {
  const uuid = randomUUID();
  return DeploymentIdSchema.parse(`dep_${uuid.slice(0, 14)}7${uuid.slice(15)}`);
}

function workflowVersionStatus(value: string): WorkflowVersionStatus {
  if (
    value === "compiled" ||
    value === "tested" ||
    value === "canary" ||
    value === "promoted" ||
    value === "rolled_back" ||
    value === "retired"
  ) {
    return value;
  }
  throw new Error(`database returned unknown workflow version status ${value}`);
}

function assertValidStatusTransition(
  purpose: TransitionPurpose,
  from: WorkflowVersionStatus,
  to: WorkflowVersionStatus,
): void {
  if (!VALID_TRANSITIONS[purpose][from]?.includes(to)) {
    throw new DeploymentStateTransitionError(purpose, from, to);
  }
}

function isoTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("database returned an invalid promoted_at timestamp");
  }
  return parsed.toISOString();
}

function projectDeploymentFromRow(row: ProjectDeploymentRow): ProjectArtifactDeployment {
  if (row.status !== "active") {
    throw new ProjectDeploymentStateTransitionError(
      `database returned non-active deployment status ${row.status}`,
    );
  }
  return {
    id: row.id,
    projectId: row.project_id,
    artifactId: row.artifact_id,
    destinationReference: row.destination_reference,
    status: "active",
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function isRetryableDatabaseError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "40001" || code === "40P01";
}

async function readVersionSnapshot(
  tx: OrchestrationTransactionLike,
  tenantId: string,
  workflowId: string,
  targetVersionId: string,
): Promise<VersionSnapshot> {
  const result = await tx.query<WorkflowVersionRow>(
    `SELECT id, status
     FROM workflow_versions
     WHERE tenant_id = $1
       AND workflow_id = $2
       AND (id = $3 OR status IN ('promoted', 'canary'))
     ORDER BY id`,
    [tenantId, workflowId, targetVersionId],
  );
  const targetRow = result.rows.find((row) => row.id === targetVersionId);
  if (targetRow === undefined) {
    throw new DeploymentNotFoundError(
      `workflow_version_id "${targetVersionId}" was not found for workflow_id "${workflowId}"`,
    );
  }

  const promotedRows = result.rows.filter((row) => row.status === "promoted");
  if (promotedRows.length > 1) {
    throw new DeploymentConcurrencyError(
      workflowId,
      "more than one promoted version already exists",
    );
  }
  const promotedRow = promotedRows[0];
  const canaryRows = result.rows.filter((row) => row.status === "canary");
  if (canaryRows.length > 1) {
    throw new DeploymentConcurrencyError(
      workflowId,
      "more than one canary version already exists",
    );
  }
  const canaryRow = canaryRows[0];

  return {
    target: {
      id: targetRow.id,
      status: workflowVersionStatus(targetRow.status),
    },
    ...(promotedRow === undefined
      ? {}
      : {
          currentPromoted: {
            id: promotedRow.id,
            status: "promoted" as const,
          },
        }),
    ...(canaryRow === undefined
      ? {}
      : {
          currentCanary: {
            id: canaryRow.id,
            status: "canary" as const,
          },
        }),
  };
}

async function claimResourceRevision(
  tx: OrchestrationTransactionLike,
  tenantId: string,
  resourceTable: "workflows" | "projects",
  resourceId: string,
  revision: string,
): Promise<void> {
  // xmin is an exact transaction revision. Using the timestamptz value as
  // the predicate would lose sub-millisecond precision when pg converts it
  // to a JavaScript Date and would turn uncontended writes into false races.
  const result = await tx.query(
    `UPDATE ${resourceTable}
     SET updated_at = GREATEST(updated_at + interval '1 microsecond', clock_timestamp())
     WHERE tenant_id = $1 AND id = $2 AND xmin::text = $3`,
    [tenantId, resourceId, revision],
  );
  if (result.rowCount !== 1) {
    throw new RetryDeploymentWrite();
  }
}

function requireSingleWrite(rowCount: number): void {
  if (rowCount !== 1) {
    throw new RetryDeploymentWrite();
  }
}

export class WorkflowLifecycleService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly evalFacade: EvalFacadeService,
    private readonly projectArtifactDependencies?: ProjectArtifactDeploymentDependencies,
  ) {}

  /**
   * Publishes a durable artifact to tenant-scoped static S3 storage. The
   * deployment stays pending until the object write succeeds; only then does
   * an optimistic project-revision transaction make it active.
   */
  async deployProjectArtifact(
    request: ProjectArtifactDeploymentRequest,
  ): Promise<ProjectArtifactDeployment> {
    requireProjectId(request.projectId);
    requireArtifactId(request.artifactId);
    const tenantId = bareTenantUuid(request.tenantId);
    const dependencies = this.requireProjectArtifactDependencies();
    const bucket = dependencies.staticDeploymentBucket.trim();
    if (bucket.length === 0) {
      throw new ProjectDeploymentConfigurationError(
        "static deployment bucket is required",
      );
    }

    let artifact: Awaited<ReturnType<ArtifactsService["get"]>>;
    let bytes: Uint8Array;
    try {
      artifact = await dependencies.artifacts.get(
        request.tenantId,
        request.artifactId,
      );
      bytes = await dependencies.artifacts.read(
        request.tenantId,
        request.artifactId,
      );
    } catch (error: unknown) {
      if (error instanceof ArtifactNotFoundError) {
        throw new DeploymentNotFoundError(
          `artifact_id "${request.artifactId}" was not found for this tenant`,
        );
      }
      throw error;
    }
    const deploymentId = newDeploymentId();
    const destinationReference = [
      `s3://${bucket}`,
      `tenants/${tenantId}`,
      `projects/${request.projectId}`,
      `deployments/${deploymentId}`,
      `artifacts/${request.artifactId}`,
    ].join("/");

    await this.createPendingProjectDeployment(
      tenantId,
      request.projectId,
      deploymentId,
      request.artifactId,
      destinationReference,
    );

    try {
      await dependencies.objects.putObject(
        destinationReference,
        Buffer.from(bytes),
        artifact.contentType,
      );
    } catch (error: unknown) {
      await this.markProjectDeploymentFailed(tenantId, request.projectId, deploymentId);
      throw error;
    }

    try {
      return await this.activateProjectDeployment(
        tenantId,
        request.projectId,
        deploymentId,
      );
    } catch (error: unknown) {
      try {
        await dependencies.objects.deleteObject(destinationReference);
      } catch {
        // The deployment remains non-active and is traceable for remediation.
      }
      await this.markProjectDeploymentFailed(tenantId, request.projectId, deploymentId);
      throw error;
    }
  }

  async testVersion(request: { readonly tenant_id: string; readonly workflow_id: string; readonly workflow_version_id: string }): Promise<{ readonly status: "tested" }> {
    requireWorkflowId(request.workflow_id);
    requireWorkflowVersionId("workflow_version_id", request.workflow_version_id);
    const tenantId = bareTenantUuid(request.tenant_id);

    // Validate tenant ownership before invoking the external evaluator.  The
    // evaluation itself remains outside a database transaction.
    await this.store.withTenant(tenantId, async (tx) => {
      await readVersionSnapshot(tx, tenantId, request.workflow_id, request.workflow_version_id);
    });

    const evaluation = await this.evalFacade.runEvaluation({ golden_set_name: "workflow E2E" });
    const gate = await this.evalFacade.checkReleaseGate({ release_gate_key: `workflow:${request.workflow_id}:${request.workflow_version_id}`, evaluation_run_id: evaluation.evaluation_run_id });
    if (!gate.passed) {
      await this.withOptimisticRetry(tenantId, request.workflow_id, async (tx, revision) => {
        await claimResourceRevision(tx, tenantId, "workflows", request.workflow_id, revision);
        const failed = await tx.query("UPDATE workflow_versions SET evaluation_run_id = $4, evaluation_failed_at = clock_timestamp() WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = 'compiled'", [tenantId, request.workflow_id, request.workflow_version_id, evaluation.evaluation_run_id]);
        requireSingleWrite(failed.rowCount);
        return undefined;
      });
      throw new ReleaseGateFailedError(gate.failed_thresholds);
    }
    return this.withOptimisticRetry(tenantId, request.workflow_id, async (tx, revision) => {
      const snapshot = await readVersionSnapshot(tx, tenantId, request.workflow_id, request.workflow_version_id);
      assertValidStatusTransition("test_version", snapshot.target.status, "tested");
      await claimResourceRevision(tx, tenantId, "workflows", request.workflow_id, revision);
      const tested = await tx.query("UPDATE workflow_versions SET status = 'tested', evaluation_run_id = $4, tested_at = clock_timestamp(), evaluation_failed_at = NULL WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = 'compiled'", [tenantId, request.workflow_id, request.workflow_version_id, evaluation.evaluation_run_id]);
      requireSingleWrite(tested.rowCount);
      return { status: "tested" as const };
    });
  }

  async promoteVersion(
    request: DeployctlPromoteVersionRequest,
  ): Promise<DeployctlPromoteVersionResponse> {
    requireWorkflowId(request.workflow_id);
    requireWorkflowVersionId(
      "workflow_version_id",
      request.workflow_version_id,
    );
    const tenantId = bareTenantUuid(request.tenant_id);

    return this.withOptimisticRetry(tenantId, request.workflow_id, async (tx, revision) => {
      const snapshot = await readVersionSnapshot(
        tx,
        tenantId,
        request.workflow_id,
        request.workflow_version_id,
      );
      assertValidStatusTransition(
        "promote_target",
        snapshot.target.status,
        "promoted",
      );
      if (snapshot.currentPromoted !== undefined) {
        assertValidStatusTransition(
          "retire_current",
          snapshot.currentPromoted.status,
          "retired",
        );
      }

      await claimResourceRevision(tx, tenantId, "workflows", request.workflow_id, revision);

      if (snapshot.currentPromoted !== undefined) {
        const retired = await tx.query(
          `UPDATE workflow_versions
           SET status = 'retired', traffic_percent = NULL
           WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = 'promoted'`,
          [tenantId, request.workflow_id, snapshot.currentPromoted.id],
        );
        requireSingleWrite(retired.rowCount);
      }

      const promoted = await tx.query<PromotedAtRow>(
        `UPDATE workflow_versions
         SET status = 'promoted', traffic_percent = NULL,
             last_deployed_at = clock_timestamp(), last_deploy_kind = 'promoted'
         WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = $4
         RETURNING clock_timestamp() AS promoted_at`,
        [
          tenantId,
          request.workflow_id,
          request.workflow_version_id,
          snapshot.target.status,
        ],
      );
      requireSingleWrite(promoted.rowCount);

      return {
        status: "promoted",
        promoted_at: isoTimestamp(promoted.rows[0]!.promoted_at),
      };
    });
  }

  async startCanary(
    request: DeployctlStartCanaryRequest,
  ): Promise<DeployctlStartCanaryResponse> {
    requireWorkflowId(request.workflow_id);
    requireWorkflowVersionId(
      "workflow_version_id",
      request.workflow_version_id,
    );
    requireTrafficPercent(request.traffic_percent);
    const tenantId = bareTenantUuid(request.tenant_id);

    return this.withOptimisticRetry(tenantId, request.workflow_id, async (tx, revision) => {
      const snapshot = await readVersionSnapshot(
        tx,
        tenantId,
        request.workflow_id,
        request.workflow_version_id,
      );
      if (
        snapshot.currentCanary !== undefined &&
        snapshot.currentCanary.id !== snapshot.target.id
      ) {
        throw new DeploymentStateTransitionError(
          "start_canary",
          snapshot.currentCanary.status,
          "canary",
        );
      }
      assertValidStatusTransition(
        "start_canary",
        snapshot.target.status,
        "canary",
      );

      await claimResourceRevision(tx, tenantId, "workflows", request.workflow_id, revision);
      const canary = await tx.query(
        `UPDATE workflow_versions
         SET status = 'canary', traffic_percent = $4
         WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = 'tested'`,
        [
          tenantId,
          request.workflow_id,
          request.workflow_version_id,
          request.traffic_percent,
        ],
      );
      requireSingleWrite(canary.rowCount);

      return {
        status: "canary",
        traffic_percent: request.traffic_percent,
      };
    });
  }

  async rollbackVersion(
    request: DeployctlRollbackVersionRequest,
  ): Promise<DeployctlRollbackVersionResponse> {
    requireWorkflowId(request.workflow_id);
    requireWorkflowVersionId("target_version_id", request.target_version_id);
    const tenantId = bareTenantUuid(request.tenant_id);

    return this.withOptimisticRetry(tenantId, request.workflow_id, async (tx, revision) => {
      const snapshot = await readVersionSnapshot(
        tx,
        tenantId,
        request.workflow_id,
        request.target_version_id,
      );
      if (snapshot.currentPromoted === undefined) {
        throw new DeploymentStateTransitionError(
          "rollback_current",
          snapshot.target.status,
          "rolled_back",
        );
      }
      assertValidStatusTransition(
        "rollback_current",
        snapshot.currentPromoted.status,
        "rolled_back",
      );
      assertValidStatusTransition(
        "restore_target",
        snapshot.target.status,
        "promoted",
      );

      await claimResourceRevision(tx, tenantId, "workflows", request.workflow_id, revision);
      const rolledBack = await tx.query(
        `UPDATE workflow_versions
         SET status = 'rolled_back', traffic_percent = NULL
         WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = 'promoted'`,
        [tenantId, request.workflow_id, snapshot.currentPromoted.id],
      );
      requireSingleWrite(rolledBack.rowCount);

      const restored = await tx.query(
        `UPDATE workflow_versions
         SET status = 'promoted', traffic_percent = NULL,
             last_deployed_at = clock_timestamp(), last_deploy_kind = 'restored'
         WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3 AND status = 'retired'`,
        [tenantId, request.workflow_id, request.target_version_id],
      );
      requireSingleWrite(restored.rowCount);

      return {
        status: "rolled_back",
        active_version_id: request.target_version_id,
      };
    });
  }

  private requireProjectArtifactDependencies(): ProjectArtifactDeploymentDependencies {
    if (this.projectArtifactDependencies === undefined) {
      throw new ProjectDeploymentConfigurationError(
        "project artifact deployment dependencies are not configured",
      );
    }
    return this.projectArtifactDependencies;
  }

  private async createPendingProjectDeployment(
    tenantId: string,
    projectId: string,
    deploymentId: string,
    artifactId: string,
    destinationReference: string,
  ): Promise<void> {
    await this.withProjectOptimisticRetry(tenantId, projectId, async (tx, revision) => {
      await claimResourceRevision(tx, tenantId, "projects", projectId, revision);
      const created = await tx.query(
        `INSERT INTO deployments
           (id, tenant_id, project_id, artifact_id, destination_reference, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [deploymentId, tenantId, projectId, artifactId, destinationReference],
      );
      requireSingleWrite(created.rowCount);
    });
  }

  private async activateProjectDeployment(
    tenantId: string,
    projectId: string,
    deploymentId: string,
  ): Promise<ProjectArtifactDeployment> {
    return this.withProjectOptimisticRetry(tenantId, projectId, async (tx, revision) => {
      const snapshot = await tx.query<ProjectDeploymentRow>(
        `SELECT id, project_id, artifact_id, destination_reference, status,
                created_at::text, updated_at::text
         FROM deployments
         WHERE tenant_id = $1
           AND project_id = $2
           AND (id = $3 OR status = 'active')
         ORDER BY id`,
        [tenantId, projectId, deploymentId],
      );
      const target = snapshot.rows.find((row) => row.id === deploymentId);
      if (target === undefined) {
        throw new DeploymentNotFoundError(
          `deployment_id "${deploymentId}" was not found for project_id "${projectId}"`,
        );
      }
      if (target.status !== "pending") {
        throw new ProjectDeploymentStateTransitionError(
          `deployment_id "${deploymentId}" cannot transition from ${target.status} to active`,
        );
      }
      const activeRows = snapshot.rows.filter((row) => row.status === "active");
      if (activeRows.length > 1) {
        throw new DeploymentConcurrencyError(
          projectId,
          "more than one active project deployment already exists",
          "project",
        );
      }

      await claimResourceRevision(tx, tenantId, "projects", projectId, revision);
      const current = activeRows[0];
      if (current !== undefined) {
        const rolledBack = await tx.query(
          `UPDATE deployments
           SET status = 'rolled_back', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'`,
          [tenantId, projectId, current.id],
        );
        requireSingleWrite(rolledBack.rowCount);
      }

      const activated = await tx.query<ProjectDeploymentRow>(
        `UPDATE deployments
         SET status = 'active', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'pending'
         RETURNING id, project_id, artifact_id, destination_reference, status,
                   created_at::text, updated_at::text`,
        [tenantId, projectId, deploymentId],
      );
      requireSingleWrite(activated.rowCount);
      return projectDeploymentFromRow(activated.rows[0]!);
    });
  }

  private async markProjectDeploymentFailed(
    tenantId: string,
    projectId: string,
    deploymentId: string,
  ): Promise<void> {
    try {
      await this.withProjectOptimisticRetry(tenantId, projectId, async (tx, revision) => {
        await claimResourceRevision(tx, tenantId, "projects", projectId, revision);
        const failed = await tx.query(
          `UPDATE deployments
           SET status = 'failed', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'pending'`,
          [tenantId, projectId, deploymentId],
        );
        requireSingleWrite(failed.rowCount);
      });
    } catch {
      // Preserve the S3 or activation failure that triggered this cleanup.
    }
  }

  private async withOptimisticRetry<T>(
    tenantId: string,
    workflowId: string,
    operation: (
      tx: OrchestrationTransactionLike,
      revision: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withResourceOptimisticRetry(
      tenantId,
      "workflows",
      workflowId,
      "workflow",
      operation,
    );
  }

  private async withProjectOptimisticRetry<T>(
    tenantId: string,
    projectId: string,
    operation: (
      tx: OrchestrationTransactionLike,
      revision: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withResourceOptimisticRetry(
      tenantId,
      "projects",
      projectId,
      "project",
      operation,
    );
  }

  private async withResourceOptimisticRetry<T>(
    tenantId: string,
    resourceTable: "workflows" | "projects",
    resourceId: string,
    resourceKind: "workflow" | "project",
    operation: (
      tx: OrchestrationTransactionLike,
      revision: string,
    ) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return await this.store.withTenant(tenantId, async (tx) => {
          const resource = await tx.query<WorkflowRevisionRow>(
            `SELECT xmin::text AS revision
             FROM ${resourceTable}
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, resourceId],
          );
          const row = resource.rows[0];
          if (row === undefined) {
            throw new DeploymentNotFoundError(
              `${resourceKind}_id "${resourceId}" was not found`,
            );
          }
          return operation(tx, row.revision);
        });
      } catch (error: unknown) {
        if (error instanceof RetryDeploymentWrite || isRetryableDatabaseError(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new DeploymentConcurrencyError(
      resourceId,
      `${MAX_WRITE_ATTEMPTS} optimistic write attempts were exhausted`,
      resourceKind,
    );
  }
}
