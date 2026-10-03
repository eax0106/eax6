import { randomUUID } from "node:crypto";

import {
  CompiledDagSchema,
  RunIdSchema,
  TenantIdSchema,
  WorkflowIdSchema,
  WorkflowVersionIdSchema,
  type CompiledDag,
} from "@alterx/contracts";
import type {
  DurableExecutionProvider,
  DurableWorkflowHandle,
  AuditEventHandler,
} from "@alterx/shared-clients";
import { replayActions, replayToken, storedReplayEvent, ReplayConfirmationError, type ReplayActor } from "../trigger-registry/event-replay.service";
import type { RunBudgetGate } from "../budgets/run-budget-gate";
import type { RunOutcomeService } from "./run-outcome.service";
import { DurableRunQueue } from "./durable-run-queue.service";
import { isWorkspaceHeld } from "../workspace-holds/workspace-holds.service";
import {
  ProjectRunProvisioningError,
  type ProjectRunProvisioningInput,
  type ProjectRunProvisioningService,
} from "./project-run-provisioning.service";

const EXECUTOR_WORKFLOW_TYPE = "executorWorkflow";
const RUNNABLE_VERSION_STATUSES = new Set(["compiled", "canary", "promoted"]);
const DEFAULT_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MIN_RUN_TIMEOUT_MS = 1_000;
const MAX_RUN_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
// ENGINE-FIX-P3-11: DurableRunQueue's `attempts` counter already existed
// (incremented on every claimNext) but nothing ever read it -- a run whose
// dispatch kept failing transiently retried forever, indefinitely, with no
// terminal state. 5 total dispatch attempts before giving up and marking
// the run failed.
const MAX_QUEUE_DISPATCH_ATTEMPTS = 5;

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

export class RunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunValidationError";
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = "RunNotFoundError";
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Workflow ${workflowId} was not found`);
    this.name = "WorkflowNotFoundError";
  }
}

export class RunStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStateConflictError";
  }
}

/** D2: the workspace is pending deletion, so no run may start in it. */
export class WorkspacePendingDeletionError extends RunStateConflictError {
  constructor() {
    super("Workspace is pending deletion; no run can start until it is restored");
    this.name = "WorkspacePendingDeletionError";
  }
}

export class RunStartFailedError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Run ${runId} failed to start its durable workflow`, { cause });
    this.name = "RunStartFailedError";
  }
}

export class RunDispatchAbandonedError extends Error {
  constructor(runId: string, attempts: number, cause: unknown) {
    super(`Run ${runId} was abandoned after ${attempts} failed dispatch attempts`, { cause });
    this.name = "RunDispatchAbandonedError";
  }
}

export class ProjectRunProvisioningFailedError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Run ${runId} failed to provision its sandbox session`, { cause });
    this.name = "ProjectRunProvisioningFailedError";
  }
}

export class ProjectRunProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was not found`);
    this.name = "ProjectRunProjectNotFoundError";
  }
}

export interface RunRow extends Record<string, unknown> {
  readonly id: string;
  readonly workflow_id: string | null;
  readonly project_id?: string | null;
  readonly workflow_version_id: string | null;
  // ENGINE-FIX-P5-1b: additive on every RUN_SELECT_COLUMNS consumer so the
  // run read response can disclose owning workspace to platform-api's
  // workspace-bound RBAC resolver.
  readonly workspace_id?: string;
  readonly provisioning_session_id?: string | null;
  readonly provisioning_cycle_id?: string | null;
  readonly provisioning_template_id?: string | null;
  readonly provisioning_closed_at?: string | null;
  readonly parent_kind: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly deadline_at?: string | null;
  readonly created_at: string;
  readonly triggering_event_id?: string | null;
  readonly replayed_from?: string | null;
  readonly replay_confirmed_by?: string | null;
  readonly replay_confirmation_token?: string | null;
  readonly replay_confirmed_at?: string | null;
  readonly replay_actions?: unknown;
}

export interface CreateProjectRunInput extends ProjectRunProvisioningInput {
  readonly projectId: string;
  readonly compiledDag: CompiledDag;
  readonly timeoutMs?: number;
}

export interface CreateRunOptions {
  /** Maximum durable execution time. Defaults to 24 hours. */
  readonly timeoutMs?: number;
  /** Internal dispatch priority. Larger values dispatch first. */
  readonly priority?: number;
  readonly replay?: { readonly actor: ReplayActor; readonly eventId: string; readonly confirmationToken: string; readonly requestKey: string };
}

export interface RunPage {
  readonly data: readonly RunRow[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new RunValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function requireRunId(runId: string): void {
  if (!RunIdSchema.safeParse(runId).success) {
    throw new RunValidationError("runId must be a run_ prefixed UUIDv7");
  }
}

function requireWorkflowId(workflowId: string): void {
  if (!WorkflowIdSchema.safeParse(workflowId).success) {
    throw new RunValidationError("workflowId must be a wf_ prefixed UUIDv7");
  }
}

function requireWorkflowVersionId(workflowVersionId: string): void {
  if (!WorkflowVersionIdSchema.safeParse(workflowVersionId).success) {
    throw new RunValidationError(
      "workflowVersionId must be a wfv_ prefixed UUIDv7",
    );
  }
}

function requireProjectId(projectId: string): void {
  if (!/^prj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new RunValidationError("projectId must be a prj_ prefixed UUIDv7");
  }
}

function requireProvisioningInput(input: ProjectRunProvisioningInput): void {
  if (!/^[A-Za-z0-9_-]+$/.test(input.cycle_id)) {
    throw new RunValidationError("cycle_id must be an identifier");
  }
  if (input.template_id.trim().length === 0) {
    throw new RunValidationError("template_id is required");
  }
}

function newRunId(): string {
  const id = randomUUID();
  return `run_${id.slice(0, 14)}7${id.slice(15)}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RunValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_RUN_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_RUN_TIMEOUT_MS ||
    timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    throw new RunValidationError(
      "timeoutMs must be an integer from 1000 to 604800000 milliseconds",
    );
  }
  return timeoutMs;
}

function temporalDurationUntil(deadlineAt: string | null | undefined): string {
  const deadlineMs = deadlineAt === undefined || deadlineAt === null
    ? Date.now() + DEFAULT_RUN_TIMEOUT_MS
    : Date.parse(deadlineAt);
  const remainingMs = Number.isNaN(deadlineMs)
    ? DEFAULT_RUN_TIMEOUT_MS
    : Math.max(MIN_RUN_TIMEOUT_MS, deadlineMs - Date.now());
  return `${Math.ceil(remainingMs / 1_000)}s`;
}

const RUN_SELECT_COLUMNS = `id, workflow_id, project_id, workflow_version_id,
       workspace_id,
       provisioning_session_id, provisioning_cycle_id, provisioning_template_id,
       provisioning_closed_at::text, parent_kind, status, started_at::text,
       ended_at::text, deadline_at::text, created_at::text, triggering_event_id,
       replayed_from, replay_confirmed_by::text, replay_confirmed_at::text, replay_confirmation_token, replay_actions`;

/**
 * Owns the run's actual lifecycle: creating the durable `runs` row,
 * starting the Executor's Temporal workflow, and the cancel/retry-node
 * actions. EXEC-14 -- closes the gap NodeexecService's docstring flagged
 * ("full run lifecycle... remains EXEC-14 scope").
 */
export class RunLauncherService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly durable: DurableExecutionProvider,
    private readonly runOutcomes?: RunOutcomeService,
    private readonly projectProvisioning?: ProjectRunProvisioningService,
    private readonly queue?: DurableRunQueue,
    private readonly budgetGate?: RunBudgetGate,
    private readonly audit?: AuditEventHandler,
  ) {}

  /**
   * The compiled DAG a run of this workflow would execute and the workspace it
   * would belong to, without creating anything: the input to a pre-run cost
   * estimate (D4).
   */
  async previewRun(
    tenantIdInput: string,
    workflowId: string,
    workflowVersionId?: string,
  ): Promise<{ readonly workspaceId: string; readonly workflowVersionId: string; readonly compiledDag: CompiledDag }> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireWorkflowId(workflowId);
    if (workflowVersionId !== undefined) {
      requireWorkflowVersionId(workflowVersionId);
    }
    return this.store.withTenant(tenantId, async (tx) => {
      const workflow = await tx.query<{ readonly workspace_id: string }>(
        "SELECT workspace_id FROM workflows WHERE tenant_id = $1 AND id = $2",
        [tenantId, workflowId],
      );
      if (workflow.rowCount === 0) {
        throw new WorkflowNotFoundError(workflowId);
      }
      const version = await this.resolveVersion(tx, tenantId, workflowId, workflowVersionId);
      return { workspaceId: workflow.rows[0]!.workspace_id, workflowVersionId: version.id, compiledDag: version.compiledDag };
    });
  }

  async createRun(
    tenantIdInput: string,
    workflowId: string,
    workflowVersionId?: string,
    triggeringEventId?: string,
    options: CreateRunOptions = {},
  ): Promise<RunRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireWorkflowId(workflowId);
    if (workflowVersionId !== undefined) {
      requireWorkflowVersionId(workflowVersionId);
    }
    if (triggeringEventId !== undefined && !/^evt_/.test(triggeringEventId)) {
      throw new RunValidationError(
        "triggeringEventId must be an evt_ prefixed event id",
      );
    }
    const timeoutMs = normalizeTimeout(options.timeoutMs);

    const created = await this.store.withTenant(tenantId, async (tx) => {
      const workflow = await tx.query<{ readonly id: string; readonly workspace_id: string }>(
        "SELECT id, workspace_id FROM workflows WHERE tenant_id = $1 AND id = $2",
        [tenantId, workflowId],
      );
      if (workflow.rowCount === 0) {
        throw new WorkflowNotFoundError(workflowId);
      }

      const replay = options.replay;
      if (replay !== undefined && this.queue === undefined) throw new Error("Replay dispatch queue is unavailable");
      const event = replay === undefined ? undefined : await storedReplayEvent(tx, replay.actor, replay.eventId, true);
      if (event !== undefined && (replay!.actor.tenantId !== tenantIdInput || event.workflow_id !== workflowId ||
          event.workspace_id !== workflow.rows[0]!.workspace_id || triggeringEventId !== event.event_id)) {
        throw new RunValidationError("Replay does not belong to this workflow and workspace");
      }
      if (replay !== undefined) {
        const existing = await tx.query<RunRow>(`SELECT ${RUN_SELECT_COLUMNS} FROM runs WHERE tenant_id = $1 AND replay_request_key = $2`,
          [tenantId, replay.requestKey]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.replayed_from !== replay.eventId || row.replay_confirmed_by !== replay.actor.userId.slice(4) ||
              row.replay_confirmation_token !== replay.confirmationToken) throw new RunStateConflictError("Idempotency-Key already used for a different replay");
          return { row, compiledDag: undefined };
        }
      }
      if (await isWorkspaceHeld(tx, tenantId, workflow.rows[0]!.workspace_id)) {
        throw new WorkspacePendingDeletionError();
      }
      const version = await this.resolveVersion(tx, tenantId, workflowId, workflowVersionId);
      if (replay !== undefined && (this.audit === undefined || replay.confirmationToken !== replayToken(replay.actor, event!, version.id, version.compiledDag))) {
        if (this.audit === undefined) throw new Error("Replay audit is unavailable");
        throw new ReplayConfirmationError();
      }
      const runId = newRunId();

      const inserted = await tx.query<RunRow>(
        `INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, workflow_id,
                           workflow_version_id, status, triggering_event_id, deadline_at,
                           replayed_from, replay_confirmed_by, replay_confirmed_at, replay_actions, replay_request_key, replay_confirmation_token)
         SELECT $3, $1, workspace_id, 'workflow', $2, $4, 'pending', $5,
                clock_timestamp() + ($6::bigint * interval '1 millisecond'),
                $7, $8::uuid, CASE WHEN $7::text IS NULL THEN NULL ELSE clock_timestamp() END, $9::jsonb, $10, $11
         FROM workflows WHERE tenant_id = $1 AND id = $2
         RETURNING ${RUN_SELECT_COLUMNS}`,
        [tenantId, workflowId, runId, version.id, triggeringEventId ?? null, timeoutMs,
          replay?.eventId ?? null, replay?.actor.userId.slice(4) ?? null,
          replay === undefined ? null : JSON.stringify(replayActions(version.compiledDag)), replay?.requestKey ?? null, replay?.confirmationToken ?? null],
      );
      const row = inserted.rows[0]!;
      // D3: a run over budget is refused here, and its row rolls back with it.
      await this.budgetGate?.reserve(tx, {
        tenantId,
        workspaceId: workflow.rows[0]!.workspace_id,
        workflowId,
        runId,
        compiledDag: version.compiledDag,
      });
      if (replay !== undefined) {
        const key = `replay.${runId}`;
        if (version.compiledDag.nodes.some(node => node.key === key)) throw new RunValidationError("Replay input key conflicts with a workflow node");
        await tx.query(`INSERT INTO blackboard_checkpoints (tenant_id, run_id, context_key, value_json)
          VALUES ($1, $2, $3, $4::jsonb)`, [tenantId, runId, key, JSON.stringify(event!.payload_inline)]);
        await this.queue!.enqueue(tenantId, { runId, compiledDag: version.compiledDag }, tx);
        await this.audit!.recordEvent({ tenant_id: tenantId, actor_type: "user", actor_ref: replay.actor.userId,
          action: "event.replay.confirmed", target_type: "run", target_ref: runId, result: "success", reason_code: "outside_actions_confirmed",
          context_json: JSON.stringify({ replayed_from: replay.eventId, workflow_version_id: version.id, actions: replayActions(version.compiledDag) }),
          occurred_at: new Date().toISOString() });
      }
      return { row, compiledDag: version.compiledDag };
    });

    if (created.compiledDag === undefined) {
      await this.#drainQueuedRuns(tenantId);
      return this.getRun(tenantIdInput, created.row.id);
    }
    return this.startAndTransition(tenantId, created.row, created.compiledDag, {
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    });
  }

  /**
   * Project builds intentionally have their own creation path: a project is
   * not a workflow and has no workflow version to resolve. The caller owns
   * the build cycle/template choice; this service durably binds the real
   * Provisioning session to the new run before the Executor can start.
   */
  async createProjectRun(
    tenantIdInput: string,
    input: CreateProjectRunInput,
  ): Promise<RunRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireProjectId(input.projectId);
    requireProvisioningInput(input);
    const timeoutMs = normalizeTimeout(input.timeoutMs);
    const parsedDag = CompiledDagSchema.safeParse(input.compiledDag);
    if (!parsedDag.success) {
      throw new RunValidationError(
        `project build compiled_dag failed schema validation: ${parsedDag.error.message}`,
      );
    }
    if (this.projectProvisioning === undefined) {
      throw new ProjectRunProvisioningError(
        "Project run provisioning is not configured",
      );
    }

    const row = await this.store.withTenant(tenantId, async (tx) => {
      const project = await tx.query<{ readonly workspace_id: string }>(
        "SELECT workspace_id FROM projects WHERE tenant_id = $1 AND id = $2",
        [tenantId, input.projectId],
      );
      if (project.rowCount === 0) {
        throw new ProjectRunProjectNotFoundError(input.projectId);
      }
      if (await isWorkspaceHeld(tx, tenantId, project.rows[0]!.workspace_id)) {
        throw new WorkspacePendingDeletionError();
      }
      const runId = newRunId();
      const inserted = await tx.query<RunRow>(
        `INSERT INTO runs
           (id, tenant_id, workspace_id, parent_kind, project_id,
            provisioning_cycle_id, provisioning_template_id, status, deadline_at)
         VALUES ($1, $2, $3, 'project', $4, $5, $6, 'pending',
                 clock_timestamp() + ($7::bigint * interval '1 millisecond'))
         RETURNING ${RUN_SELECT_COLUMNS}`,
        [
          runId,
          tenantId,
          project.rows[0]!.workspace_id,
          input.projectId,
          input.cycle_id,
          input.template_id,
          timeoutMs,
        ],
      );
      return inserted.rows[0]!;
    });

    try {
      await this.projectProvisioning.provisionForRun(
        tenantIdInput,
        row.id,
        input.projectId,
        input,
      );
    } catch (error: unknown) {
      await this.markProjectRunProvisioningFailed(tenantId, tenantIdInput, row.id);
      throw new ProjectRunProvisioningFailedError(row.id, error);
    }

    const provisioned = await this.getRun(tenantIdInput, row.id);
    return this.startAndTransition(tenantId, provisioned, parsedDag.data);
  }

  async listRuns(
    tenantIdInput: string,
    query: {
      readonly workspaceId?: string;
      readonly workflowId?: string;
      readonly mode?: "workflow" | "project";
      readonly status?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<RunPage> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const limit = normalizeLimit(query.limit);
    if (query.workflowId !== undefined) requireWorkflowId(query.workflowId);
    if (query.mode !== undefined && query.mode !== "workflow" && query.mode !== "project") {
      throw new RunValidationError("mode must be workflow or project");
    }
    if (query.cursor !== undefined) requireRunId(query.cursor);

    return this.store.withTenant(tenantId, async (tx) => {
      const conditions: string[] = ["tenant_id = $1"];
      const values: unknown[] = [tenantId];
      if (query.workspaceId !== undefined) {
        values.push(query.workspaceId);
        conditions.push(`workspace_id = $${values.length}`);
      }

      if (query.workflowId !== undefined) {
        values.push(query.workflowId);
        conditions.push(`workflow_id = $${values.length}`);
      }
      if (query.mode !== undefined) {
        values.push(query.mode);
        conditions.push(`parent_kind = $${values.length}`);
      }
      if (query.status !== undefined) {
        values.push(query.status);
        conditions.push(`status = $${values.length}`);
      }
      if (query.cursor !== undefined) {
        const cursorRow = await tx.query<{ readonly created_at: string }>(
          "SELECT created_at::text FROM runs WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR workspace_id = $3)",
          [tenantId, query.cursor, query.workspaceId ?? null],
        );
        const createdAt = cursorRow.rows[0]?.created_at;
        if (createdAt === undefined) {
          throw new RunValidationError("cursor does not belong to this tenant");
        }
        values.push(createdAt, query.cursor);
        conditions.push(
          `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`,
        );
      }

      values.push(limit + 1);
      const result = await tx.query<RunRow>(
        `SELECT ${RUN_SELECT_COLUMNS}
         FROM runs WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length}`,
        values,
      );
      const rows = [...result.rows];
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return {
        data,
        page: {
          next_cursor: hasMore ? data.at(-1)?.id ?? null : null,
          has_more: hasMore,
          limit,
        },
      };
    });
  }

  async getRun(tenantIdInput: string, runId: string): Promise<RunRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireRunId(runId);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<RunRow>(
        `SELECT ${RUN_SELECT_COLUMNS} FROM runs WHERE tenant_id = $1 AND id = $2`,
        [tenantId, runId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new RunNotFoundError(runId);
      return row;
    });
  }

  async cancelRun(tenantIdInput: string, runId: string): Promise<RunRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireRunId(runId);

    const current = await this.getRun(tenantIdInput, runId);
    if (["pending", "running", "paused"].includes(current.status)) {
      try {
        await this.durable.terminateWorkflow({
          workflowId: runId,
          reason: "Cancelled via API",
        });
      } catch {
        // Best-effort: the workflow may have already closed (raced with
        // finalizeRun) between the read above and this call. The
        // optimistic UPDATE below is the real source of truth.
      }
    }

    const row = await this.store.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<RunRow>(
        `UPDATE runs SET status = 'cancelled', ended_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'running', 'paused')
         RETURNING ${RUN_SELECT_COLUMNS}`,
        [tenantId, runId],
      );
      if (updated.rowCount === 1) return updated.rows[0]!;

      // Already terminal (finished/failed/cancelled concurrently) --
      // cancelling an already-finished run is a no-op, not an error.
      const result = await tx.query<RunRow>(
        `SELECT ${RUN_SELECT_COLUMNS} FROM runs WHERE tenant_id = $1 AND id = $2`,
        [tenantId, runId],
      );
      const existing = result.rows[0];
      if (existing === undefined) throw new RunNotFoundError(runId);
      return existing;
    });

    // HEAL-8: durable.terminateWorkflow (above) hard-kills the Temporal
    // workflow execution when it succeeds -- the Executor's own
    // try/finally (NodeexecService.finalizeRun) then never runs, so this
    // is the only real write site for a 'cancelled' verdict. Idempotent
    // (ON CONFLICT DO NOTHING) against the race the comment above already
    // documents; also a safe no-op if the run was already terminal for a
    // different real reason (completed/failed already wrote their own
    // verdict first).
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      try {
        await this.runOutcomes?.recordOutcome(tenantIdInput, runId, row.status);
      } catch (error: unknown) {
        console.error("run_outcomes write failed -- VACR/VADR metrics gap", {
          run_id: runId,
          status: row.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.projectProvisioning?.closeForTerminalRun(tenantIdInput, runId);
    await this.queue?.discard(tenantId, runId);
    return row;
  }

  async retrySignal(
    tenantIdInput: string,
    runId: string,
    nodeExecutionId: string,
  ): Promise<void> {
    bareTenantUuid(tenantIdInput);
    requireRunId(runId);
    if (nodeExecutionId.trim().length === 0) {
      throw new RunValidationError("node_execution_id is required");
    }

    const runRow = await this.getRun(tenantIdInput, runId);
    if (runRow.status !== "running") {
      throw new RunStateConflictError(
        `retry-signal requires run status "running", got "${runRow.status}"`,
      );
    }

    await this.durable.signalWorkflow({
      workflowId: runId,
      signalName: "nodeRetryDecided",
      payload: { nodeExecutionId, action: "retry" },
    });
  }

  async retryNode(
    tenantIdInput: string,
    runId: string,
    nodeKey: string,
  ): Promise<RunRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireRunId(runId);
    if (nodeKey.trim().length === 0) {
      throw new RunValidationError("node_key is required");
    }

    const { row, compiledDag } = await this.store.withTenant(tenantId, async (tx) => {
      const runResult = await tx.query<
        RunRow & { readonly workflow_version_id: string | null }
      >(
        `SELECT ${RUN_SELECT_COLUMNS} FROM runs WHERE tenant_id = $1 AND id = $2`,
        [tenantId, runId],
      );
      const runRow = runResult.rows[0];
      if (runRow === undefined) throw new RunNotFoundError(runId);
      if (runRow.status !== "failed") {
        throw new RunStateConflictError(
          `retry-node requires run status "failed", got "${runRow.status}"`,
        );
      }
      if (runRow.workflow_version_id === null) {
        throw new RunStateConflictError(
          "run has no recorded workflow_version_id -- cannot resolve its compiled DAG",
        );
      }

      const versionResult = await tx.query<{ readonly compiled_dag: unknown }>(
        "SELECT compiled_dag FROM workflow_versions WHERE tenant_id = $1 AND id = $2",
        [tenantId, runRow.workflow_version_id],
      );
      const compiledDagRaw = versionResult.rows[0]?.compiled_dag;
      if (compiledDagRaw === undefined) {
        throw new RunStateConflictError(
          `workflow_version ${runRow.workflow_version_id} referenced by this run no longer exists`,
        );
      }
      const parsedDag = CompiledDagSchema.safeParse(compiledDagRaw);
      if (!parsedDag.success) {
        throw new RunStateConflictError(
          "run's recorded compiled DAG failed schema validation",
        );
      }
      const node = parsedDag.data.nodes.find((candidate) => candidate.key === nodeKey);
      if (node === undefined) {
        throw new RunValidationError(
          `node_key "${nodeKey}" does not exist in this run's compiled DAG`,
        );
      }

      const updated = await tx.query<RunRow>(
        `UPDATE runs
         SET status = 'running', ended_at = NULL,
             started_at = COALESCE(started_at, clock_timestamp())
         WHERE tenant_id = $1 AND id = $2 AND status = 'failed'
         RETURNING ${RUN_SELECT_COLUMNS}`,
        [tenantId, runId],
      );
      if (updated.rowCount !== 1) {
        throw new RunStateConflictError(
          `run ${runId} was retried concurrently by another request`,
        );
      }

      const narrowedDag: CompiledDag = {
        schema_version: parsedDag.data.schema_version,
        entry_node_keys: [nodeKey],
        nodes: [node],
        edges: [],
        waves: [{ key: "retry", order: 0, node_keys: [nodeKey], depends_on: [] }],
      };
      return { row: updated.rows[0]!, compiledDag: narrowedDag };
    });

    return this.startAndTransition(tenantId, row, compiledDag, { alreadyRunning: true });
  }

  private async resolveVersion(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    workflowId: string,
    workflowVersionId: string | undefined,
  ): Promise<{ readonly id: string; readonly compiledDag: CompiledDag }> {
    if (workflowVersionId !== undefined) {
      const result = await tx.query<{ readonly id: string; readonly status: string; readonly compiled_dag: unknown }>(
        "SELECT id, status, compiled_dag FROM workflow_versions WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3",
        [tenantId, workflowId, workflowVersionId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new RunValidationError(
          `workflow_version_id "${workflowVersionId}" was not found for this workflow`,
        );
      }
      if (!RUNNABLE_VERSION_STATUSES.has(row.status)) {
        throw new RunValidationError(
          `workflow_version_id "${workflowVersionId}" has status "${row.status}" and cannot be run`,
        );
      }
      return { id: row.id, compiledDag: parseCompiledDag(row.compiled_dag) };
    }

    const promoted = await tx.query<{ readonly id: string; readonly compiled_dag: unknown }>(
      "SELECT id, compiled_dag FROM workflow_versions WHERE tenant_id = $1 AND workflow_id = $2 AND status = 'promoted'",
      [tenantId, workflowId],
    );
    const row = promoted.rows[0];
    if (row === undefined) {
      throw new RunValidationError(
        "workflow has no promoted version -- pass an explicit workflow_version_id",
      );
    }
    return { id: row.id, compiledDag: parseCompiledDag(row.compiled_dag) };
  }

  /**
   * Starts the Executor's Temporal workflow for an already-created run row
   * and transitions it to `running`. Public because the dispatch path
   * (TriggerEventDispatchService) inserts its own run row in the same
   * transaction as the `events` row and reuses this exact start/transition
   * sequence afterwards.
   */
  async startAndTransition(
    tenantId: string,
    row: RunRow,
    compiledDag: CompiledDag,
    options: { readonly alreadyRunning?: boolean; readonly priority?: number } = {},
  ): Promise<RunRow> {
    if (this.queue !== undefined) {
      await this.queue.enqueue(tenantId, {
        runId: row.id,
        compiledDag,
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.alreadyRunning === true ? { alreadyRunning: true } : {}),
      });
      await this.#drainQueuedRuns(tenantId);
      return this.getRun(`ten_${tenantId}`, row.id);
    }
    return this.startClaimedAndTransition(tenantId, row, compiledDag, options);
  }

  /**
   * ENGINE-FIX-P3-5. Draining exactly one entry per enqueue meant a
   * displaced run (claimNext orders by priority/age, not "the one that
   * was just enqueued") only ever got dispatched by a *later, unrelated*
   * launch for the same tenant -- never, if that was the tenant's last
   * launch. Looping here until the tenant's queue is actually empty also
   * opportunistically drains any retryLater-delayed or lease-expired
   * entry whose time has since come, for the same reason: nothing else
   * in this service returns to a tenant's queue without a new run.
   *
   * This is the audit's own "loop claimNext until it returns undefined"
   * alternative, not the other option it names (a standalone cross-tenant
   * background sweeper on an interval) -- that would need its own
   * cross-tenant-capable DB role provisioned outside this codebase (no
   * IaC deploys these services yet, see the deletion service's own
   * DELETION_DATABASE_USER for what that would take), so it's
   * deliberately not attempted here. This closes the common case (a
   * tenant's own subsequent activity fully drains their backlog) without
   * needing new infrastructure; a genuinely dormant tenant with a stuck
   * retry and no further launches ever is not covered by either this fix
   * or the absence of one -- still open.
   *
   * The cap is a defensive bound against a pathological claimNext bug,
   * not a tenant-fairness mechanism -- this only ever touches the one
   * tenant that just enqueued, so cross-tenant fairness doesn't apply.
   *
   * ENGINE-FIX-P3-11: dispatchNextQueuedRun can throw for a *different*,
   * unrelated queue entry than the run this call's own caller is trying to
   * launch (a displaced backlog entry hitting a transient error, or now
   * exhausting MAX_QUEUE_DISPATCH_ATTEMPTS and being dead-lettered). That
   * failure is real and worth logging, but it must never fail the request
   * that triggered this drain -- that request's own run was already
   * durably enqueued before drain ran. Caught and logged per iteration,
   * not propagated.
   */
  async #drainQueuedRuns(tenantId: string): Promise<void> {
    const MAX_DRAIN_PER_CALL = 100;
    for (let iteration = 0; iteration < MAX_DRAIN_PER_CALL; iteration += 1) {
      try {
        const dispatched = await this.dispatchNextQueuedRun(tenantId);
        if (dispatched === undefined) return;
      } catch (error: unknown) {
        console.error("drainQueuedRuns: dispatch failed for a queued run, continuing drain", {
          tenant_id: tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Claims one durable queue entry. Entry is only removed after its durable
   * Temporal start and run-state transition both complete. */
  async dispatchNextQueuedRun(tenantId: string): Promise<RunRow | undefined> {
    if (this.queue === undefined) return undefined;
    const claimed = await this.queue.claimNext(tenantId);
    if (claimed === undefined) return undefined;
    const tenantIdWithPrefix = `ten_${tenantId}`;
    try {
      const row = await this.getRun(tenantIdWithPrefix, claimed.runId);
      if (["completed", "failed", "cancelled"].includes(row.status)) {
        await this.queue.acknowledge(tenantId, claimed.runId, claimed.leaseToken);
        return row;
      }
      // D2: a queued run in a workspace pending deletion never starts; it is
      // cancelled and its queue entry acknowledged.
      const cancelled = await this.#cancelIfWorkspaceHeld(tenantId, row);
      if (cancelled !== undefined) {
        await this.queue.acknowledge(tenantId, claimed.runId, claimed.leaseToken);
        return cancelled;
      }
      const started = await this.startClaimedAndTransition(
        tenantId,
        row,
        claimed.compiledDag,
        { alreadyRunning: claimed.alreadyRunning },
      );
      await this.queue.acknowledge(tenantId, claimed.runId, claimed.leaseToken);
      return started;
    } catch (error: unknown) {
      if (error instanceof RunStartFailedError) {
        // startClaimedAndTransition has made this specific, non-retryable
        // startup failure terminal (run already marked 'failed', outcome
        // recorded). Ack it so the queue entry doesn't outlive a run that's
        // already resolved.
        await this.queue.acknowledge(tenantId, claimed.runId, claimed.leaseToken);
        throw error;
      }
      if (claimed.attempt >= MAX_QUEUE_DISPATCH_ATTEMPTS) {
        await this.#deadLetterQueuedRun(tenantId, tenantIdWithPrefix, claimed.runId, error);
        throw new RunDispatchAbandonedError(claimed.runId, claimed.attempt, error);
      }
      // Anything else here -- a transient error from getRun (connection
      // blip, statement timeout, pool exhaustion) most commonly -- means
      // the run was never actually transitioned or marked terminal. Do NOT
      // acknowledge: that would delete the queue entry for a run that's
      // still legitimately pending, with nothing left pointing at it. Let
      // the lease expire naturally so a sweeper can reclaim and retry it.
      throw error;
    }
  }

  async #cancelIfWorkspaceHeld(tenantId: string, row: RunRow): Promise<RunRow | undefined> {
    return this.store.withTenant(tenantId, async (tx) => {
      if (row.workspace_id === undefined || !(await isWorkspaceHeld(tx, tenantId, row.workspace_id))) return undefined;
      const updated = await tx.query<RunRow>(
        `UPDATE runs SET status = 'cancelled', ended_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING ${RUN_SELECT_COLUMNS}`,
        [tenantId, row.id],
      );
      return updated.rows[0] ?? row;
    });
  }

  /**
   * ENGINE-FIX-P3-11. Terminal transition for a run whose dispatch has
   * failed MAX_QUEUE_DISPATCH_ATTEMPTS times. Mirrors the exact
   * mark-failed/record-outcome/close-provisioning sequence
   * startClaimedAndTransition uses for a RunStartFailedError, since the
   * end state is the same: this run will never start. `discard`, not
   * `acknowledge` -- this is an unconditional give-up, not a
   * lease-token-matched ack of one attempt.
   */
  async #deadLetterQueuedRun(
    tenantId: string,
    tenantIdWithPrefix: string,
    runId: string,
    cause: unknown,
  ): Promise<void> {
    console.error("dispatchNextQueuedRun: abandoning run after max attempts", {
      tenant_id: tenantId,
      run_id: runId,
      max_attempts: MAX_QUEUE_DISPATCH_ATTEMPTS,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE runs SET status = 'failed', ended_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'running')`,
        [tenantId, runId],
      );
    });
    try {
      await this.runOutcomes?.recordOutcome(tenantIdWithPrefix, runId, "failed");
    } catch (outcomeError: unknown) {
      console.error("run_outcomes write failed -- VACR/VADR metrics gap", {
        run_id: runId,
        status: "failed",
        error: outcomeError instanceof Error ? outcomeError.message : String(outcomeError),
      });
    }
    await this.projectProvisioning?.closeForTerminalRun(tenantIdWithPrefix, runId);
    await this.queue?.discard(tenantId, runId);
  }

  private async startClaimedAndTransition(
    tenantId: string,
    row: RunRow,
    compiledDag: CompiledDag,
    options: { readonly alreadyRunning?: boolean } = {},
  ): Promise<RunRow> {
    const tenantIdWithPrefix = `ten_${tenantId}`;
    let handle: DurableWorkflowHandle;
    try {
      handle = await this.durable.startWorkflow({
        workflowId: row.id,
        workflowType: EXECUTOR_WORKFLOW_TYPE,
        input: {
          tenantId: tenantIdWithPrefix,
          runId: row.id,
          compiledDagJson: JSON.stringify(compiledDag),
          ...(row.replayed_from ? { initialInputKey: `replay.${row.id}` } : {}),
        },
        executionTimeout: temporalDurationUntil(row.deadline_at),
      });
    } catch (error: unknown) {
      await this.store.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE runs SET status = 'failed', ended_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'running')`,
          [tenantId, row.id],
        );
      });
      // HEAL-8: this run's Temporal workflow never started, so the
      // Executor's own try/finally (NodeexecService.finalizeRun) will
      // never run for it either -- the only real write site for this
      // run's verdict.
      try {
        await this.runOutcomes?.recordOutcome(tenantIdWithPrefix, row.id, "failed");
      } catch (outcomeError: unknown) {
        console.error("run_outcomes write failed -- VACR/VADR metrics gap", {
          run_id: row.id,
          status: "failed",
          error: outcomeError instanceof Error ? outcomeError.message : String(outcomeError),
        });
      }
      await this.projectProvisioning?.closeForTerminalRun(tenantIdWithPrefix, row.id);
      throw new RunStartFailedError(row.id, error);
    }
    void handle;

    if (options.alreadyRunning === true) {
      return row;
    }

    return this.store.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<RunRow>(
        `UPDATE runs SET status = 'running', started_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING ${RUN_SELECT_COLUMNS}`,
        [tenantId, row.id],
      );
      return updated.rows[0] ?? row;
    });
  }

  private async markProjectRunProvisioningFailed(
    tenantId: string,
    tenantIdInput: string,
    runId: string,
  ): Promise<void> {
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE runs SET status = 'failed', ended_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [tenantId, runId],
      );
    });
    try {
      await this.runOutcomes?.recordOutcome(tenantIdInput, runId, "failed");
    } catch (error: unknown) {
      console.error("run_outcomes write failed -- VACR/VADR metrics gap", {
        run_id: runId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.projectProvisioning?.closeForTerminalRun(tenantIdInput, runId);
  }
}

function parseCompiledDag(raw: unknown): CompiledDag {
  const parsed = CompiledDagSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RunValidationError(
      `workflow_version's compiled_dag failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
