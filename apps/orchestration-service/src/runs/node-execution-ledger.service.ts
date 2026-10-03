import {
  NodeExecutionIdSchema,
  NodeTypeSchema,
  RunIdSchema,
  TenantIdSchema,
  type ModelAlias,
} from "@alterx/contracts";

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

export type NodeExecutionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "blocked_pending_recovery"
  | "skipped"
  | "recovered";

export interface NodeExecutionStart {
  readonly tenantId: string;
  readonly runId: string;
  readonly nodeExecutionId: string;
  readonly dagNodeId: string;
  readonly nodeType: string;
  readonly modelAlias?: ModelAlias;
  /** Blackboard keys this node's inputs were read from -- comma-joined, empty for a source node. */
  readonly inputRef?: string;
}

export interface NodeExecutionRecord extends Record<string, unknown> {
  readonly id: string;
  readonly run_id: string;
  readonly dag_node_id: string;
  readonly node_type: string;
  readonly attempt: number;
  readonly model_alias: ModelAlias | null;
  readonly model_resolved: string | null;
  readonly status: NodeExecutionStatus;
  readonly input_ref: string | null;
  readonly output_ref: string | null;
  readonly error: Record<string, unknown> | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}

export interface NodeExecutionPage {
  readonly data: readonly NodeExecutionRecord[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

export interface StartedNodeExecution extends Record<string, unknown> {
  readonly attempt: number;
  readonly startedAt: string;
}

export class NodeExecutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeExecutionValidationError";
  }
}

export class NodeExecutionRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = "NodeExecutionRunNotFoundError";
  }
}

export class NodeExecutionStateConflictError extends Error {
  constructor(nodeExecutionId: string) {
    super(`Node execution ${nodeExecutionId} cannot transition from its current state`);
    this.name = "NodeExecutionStateConflictError";
  }
}

interface RunRow extends Record<string, unknown> {
  readonly id: string;
}

interface NodeExecutionStateRow extends Record<string, unknown> {
  readonly status: NodeExecutionStatus;
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new NodeExecutionValidationError(
      "tenantId must be a ten_ prefixed UUIDv7",
    );
  }
  return parsed.data.slice("ten_".length);
}

function requireRunId(runId: string): void {
  if (!RunIdSchema.safeParse(runId).success) {
    throw new NodeExecutionValidationError("runId must be a run_ prefixed UUIDv7");
  }
}

function requireNodeExecutionId(nodeExecutionId: string): void {
  if (!NodeExecutionIdSchema.safeParse(nodeExecutionId).success) {
    throw new NodeExecutionValidationError(
      "nodeExecutionId must be a node_ prefixed UUIDv7",
    );
  }
}

function requireNodeKey(nodeKey: string): void {
  if (nodeKey.trim().length === 0) {
    throw new NodeExecutionValidationError("dagNodeId is required");
  }
}

function requireNodeType(nodeType: string): void {
  if (!NodeTypeSchema.safeParse(nodeType).success) {
    throw new NodeExecutionValidationError("nodeType must be a supported NodeType");
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new NodeExecutionValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

function requireCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!NodeExecutionIdSchema.safeParse(cursor).success) {
    throw new NodeExecutionValidationError("cursor must be a node_ prefixed UUIDv7");
  }
  return cursor;
}

export class NodeExecutionLedgerService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async recordStarted(request: NodeExecutionStart): Promise<StartedNodeExecution> {
    const tenantId = bareTenantUuid(request.tenantId);
    requireRunId(request.runId);
    requireNodeExecutionId(request.nodeExecutionId);
    requireNodeKey(request.dagNodeId);
    requireNodeType(request.nodeType);

    const started = await this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<StartedNodeExecution>(
        `INSERT INTO node_executions
           (id, tenant_id, run_id, dag_node_id, node_type, model_alias, status, input_ref)
         SELECT $3, $1, $2, $4, $5, $6, 'running', $7
         FROM runs
         WHERE tenant_id = $1 AND id = $2
         ON CONFLICT (id) DO UPDATE
           SET attempt = node_executions.attempt + 1,
               status = 'running',
               error = NULL,
               output_ref = NULL,
               input_ref = EXCLUDED.input_ref,
               ended_at = NULL,
               started_at = clock_timestamp()
         WHERE node_executions.tenant_id = EXCLUDED.tenant_id
           AND node_executions.run_id = EXCLUDED.run_id
           AND node_executions.dag_node_id = EXCLUDED.dag_node_id
           AND node_executions.node_type = EXCLUDED.node_type
           AND node_executions.status = 'failed'
         RETURNING attempt,
                   to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt"`,
        [
          tenantId,
          request.runId,
          request.nodeExecutionId,
          request.dagNodeId,
          request.nodeType,
          request.modelAlias ?? null,
          request.inputRef ?? null,
        ],
      );
      return result.rows[0];
    });
    if (started !== undefined) return started;

    const runExists = await this.runExists(tenantId, request.runId);
    if (!runExists) throw new NodeExecutionRunNotFoundError(request.runId);
    throw new NodeExecutionStateConflictError(request.nodeExecutionId);
  }

  async recordSucceeded(
    request: Pick<NodeExecutionStart, "tenantId" | "runId" | "nodeExecutionId"> & {
      readonly outputRef?: string;
    },
  ): Promise<void> {
    await this.transition(request, "succeeded", null, request.outputRef ?? null);
  }

  async recordFailed(
    request: Pick<NodeExecutionStart, "tenantId" | "runId" | "nodeExecutionId">,
    error: Record<string, unknown>,
  ): Promise<void> {
    await this.transition(request, "failed", error, null);
  }

  async recordBlockedPendingRecovery(
    request: Pick<NodeExecutionStart, "tenantId" | "runId" | "nodeExecutionId">,
    reason: string,
  ): Promise<void> {
    await this.transition(request, "blocked_pending_recovery", {
      code: "VERIFICATION_BLOCKED_PENDING_RECOVERY",
      detail: reason,
    }, null);
  }

  /**
   * Design log §5.3: the end-of-run acceptance review. Belongs to the run,
   * not to any node, so node_execution_id is null and the gate is
   * 'acceptance'.
   */
  async recordRunVerificationResult(request: {
    readonly id: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly verdict: string;
    readonly score: number;
    readonly threshold: number;
    readonly reviewerModel: string;
    readonly detailsJson: string;
  }): Promise<void> {
    const tenantId = bareTenantUuid(request.tenantId);
    requireRunId(request.runId);

    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO verification_results
           (id, tenant_id, run_id, node_execution_id, gate_type, verdict,
            score, threshold, reviewer_model, details)
         VALUES ($1, $2, $3, NULL, 'acceptance', $4, $5, $6, $7, CAST($8 AS jsonb))`,
        [
          request.id,
          tenantId,
          request.runId,
          request.verdict,
          request.score,
          request.threshold,
          request.reviewerModel,
          request.detailsJson,
        ],
      );
    });
  }

  /**
   * Design log §4 / §22 item 7: whether this run's node has already reached
   * the outside world. Any recorded attempt counts -- one that never
   * reported back may still have acted, and cannot be told apart from one
   * that did.
   */
  async priorSideEffects(
    tenantIdInput: string,
    runId: string,
    dagNodeId: string,
  ): Promise<readonly { readonly toolName: string; readonly status: string }[]> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireRunId(runId);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ readonly tool_name: string; readonly status: string }>(
        `SELECT tool_name, status FROM side_effects
         WHERE tenant_id = $1 AND run_id = $2 AND dag_node_id = $3
         ORDER BY recorded_at`,
        [tenantId, runId, dagNodeId],
      );
      return result.rows.map((row) => ({ toolName: row.tool_name, status: row.status }));
    });
  }

  /** Recorded before the tool is called, so a crash mid-call still counts. */
  async recordSideEffectAttempt(request: {
    readonly id: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly dagNodeId: string;
    readonly nodeExecutionId: string;
    readonly toolName: string;
  }): Promise<void> {
    const tenantId = bareTenantUuid(request.tenantId);
    requireRunId(request.runId);
    requireNodeExecutionId(request.nodeExecutionId);
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO side_effects
           (id, tenant_id, run_id, dag_node_id, node_execution_id, tool_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'attempted')`,
        [request.id, tenantId, request.runId, request.dagNodeId, request.nodeExecutionId, request.toolName],
      );
    });
  }

  async completeSideEffect(
    tenantIdInput: string,
    id: string,
    toolAuditId: string | undefined,
    providerMessageId?: string,
  ): Promise<void> {
    const tenantId = bareTenantUuid(tenantIdInput);
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE side_effects
            SET status = 'completed', tool_audit_id = $3, provider_message_id = $4, completed_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND status = 'attempted'`,
        [tenantId, id, toolAuditId ?? null, providerMessageId ?? null],
      );
    });
  }

  /**
   * The attempt provably never reached the tool (the call was refused before
   * dispatch), so it is not evidence of an external action.
   */
  async withdrawSideEffectAttempt(tenantIdInput: string, id: string): Promise<void> {
    const tenantId = bareTenantUuid(tenantIdInput);
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        "DELETE FROM side_effects WHERE tenant_id = $1 AND id = $2 AND status = 'attempted'",
        [tenantId, id],
      );
    });
  }

  async recordVerificationResult(request: {
    readonly id: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly nodeExecutionId: string;
    readonly gateType: string;
    readonly verdict: string;
    readonly score: number;
    readonly threshold: number;
    readonly reviewerModel: string;
    readonly detailsJson: string;
  }): Promise<void> {
    const tenantId = bareTenantUuid(request.tenantId);
    requireRunId(request.runId);
    requireNodeExecutionId(request.nodeExecutionId);

    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO verification_results
           (id, tenant_id, run_id, node_execution_id, gate_type, verdict,
            score, threshold, reviewer_model, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CAST($10 AS jsonb))`,
        [
          request.id,
          tenantId,
          request.runId,
          request.nodeExecutionId,
          request.gateType,
          request.verdict,
          request.score,
          request.threshold,
          request.reviewerModel,
          request.detailsJson,
        ],
      );
    });
  }

  async list(
    tenantIdInput: string,
    runId: string,
    query: { readonly workspaceId?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<NodeExecutionPage> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireRunId(runId);
    const cursor = requireCursor(query.cursor);
    const limit = normalizeLimit(query.limit);

    return this.store.withTenant(tenantId, async (tx) => {
      const run = await tx.query<RunRow>(
        "SELECT id FROM runs WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR workspace_id = $3)",
        [tenantId, runId, query.workspaceId ?? null],
      );
      if (run.rowCount === 0) throw new NodeExecutionRunNotFoundError(runId);

      const cursorTimestamp =
        cursor === undefined
          ? undefined
          : await this.cursorTimestamp(tx, tenantId, runId, cursor);
      const result = await tx.query<NodeExecutionRecord>(
        cursorTimestamp === undefined
          ? `SELECT id, run_id, dag_node_id, node_type, attempt, model_alias,
                    model_resolved, status, input_ref, output_ref, error,
                    started_at::text, ended_at::text
             FROM node_executions
             WHERE tenant_id = $1 AND run_id = $2
             ORDER BY started_at ASC, id ASC
             LIMIT $3`
          : `SELECT id, run_id, dag_node_id, node_type, attempt, model_alias,
                    model_resolved, status, input_ref, output_ref, error,
                    started_at::text, ended_at::text
             FROM node_executions
             WHERE tenant_id = $1 AND run_id = $2
               AND (started_at, id) > ($3::timestamptz, $4)
             ORDER BY started_at ASC, id ASC
             LIMIT $5`,
        cursorTimestamp === undefined
          ? [tenantId, runId, limit + 1]
          : [tenantId, runId, cursorTimestamp, cursor, limit + 1],
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

  private async runExists(tenantId: string, runId: string): Promise<boolean> {
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<RunRow>(
        "SELECT id FROM runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, runId],
      );
      return result.rowCount === 1;
    });
  }

  private async cursorTimestamp(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    runId: string,
    cursor: string,
  ): Promise<string> {
    const result = await tx.query<{ readonly started_at: string }>(
      `SELECT started_at::text
       FROM node_executions
       WHERE tenant_id = $1 AND run_id = $2 AND id = $3`,
      [tenantId, runId, cursor],
    );
    const startedAt = result.rows[0]?.started_at;
    if (startedAt === undefined) {
      throw new NodeExecutionValidationError("cursor does not belong to this run");
    }
    return startedAt;
  }

  /**
   * Terminal write for the `runs` row itself (EXEC-14) -- called once by
   * the Executor workflow's try/finally via the FinalizeRun RPC. Idempotent:
   * a run already in a terminal state (e.g. cancelled concurrently, or a
   * retried Temporal Activity attempt after an already-acknowledged
   * finalize) is a no-op that returns the row's real current state rather
   * than erroring or clobbering a newer transition.
   */
  async finalizeRun(
    tenantIdInput: string,
    runId: string,
    status: "completed" | "failed",
  ): Promise<{ readonly status: string; readonly endedAt: string }> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireRunId(runId);
    return this.store.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ readonly status: string; readonly ended_at: string }>(
        `UPDATE runs SET status = $3, ended_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'running')
         RETURNING status, ended_at::text`,
        [tenantId, runId, status],
      );
      const row = updated.rows[0];
      if (row !== undefined) return { status: row.status, endedAt: row.ended_at };

      const current = await tx.query<{ readonly status: string; readonly ended_at: string | null }>(
        "SELECT status, ended_at::text FROM runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, runId],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined) throw new NodeExecutionRunNotFoundError(runId);
      return { status: currentRow.status, endedAt: currentRow.ended_at ?? new Date().toISOString() };
    });
  }

  private async transition(
    request: Pick<NodeExecutionStart, "tenantId" | "runId" | "nodeExecutionId">,
    status: "succeeded" | "failed" | "blocked_pending_recovery",
    error: Record<string, unknown> | null,
    outputRef: string | null,
  ): Promise<void> {
    const tenantId = bareTenantUuid(request.tenantId);
    requireRunId(request.runId);
    requireNodeExecutionId(request.nodeExecutionId);
    const result = await this.store.withTenant(tenantId, async (tx) =>
      tx.query<NodeExecutionStateRow>(
        `UPDATE node_executions
         SET status = $4,
             error = $5::jsonb,
             output_ref = $6,
             ended_at = clock_timestamp()
         WHERE tenant_id = $1 AND run_id = $2 AND id = $3 AND status = 'running'
         RETURNING status`,
        [
          tenantId,
          request.runId,
          request.nodeExecutionId,
          status,
          error === null ? null : JSON.stringify(error),
          outputRef,
        ],
      ),
    );
    if (result.rowCount !== 1) {
      throw new NodeExecutionStateConflictError(request.nodeExecutionId);
    }
  }
}
