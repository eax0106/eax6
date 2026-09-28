import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";

import { RunIdSchema, TenantIdSchema } from "@alterx/contracts";

/**
 * The VACR/VADR metric ledger writer (HEAL-8). Every run that reaches a
 * real terminal state gets exactly one row here -- there are 3 independent
 * real places a run can go terminal, found by reading the actual code
 * rather than assuming a single "run finished" hook exists:
 *
 *   1. NodeexecService.finalizeRun -- the Executor workflow's own
 *      try/finally (EXEC-14). Covers normal completion/failure, and
 *      HEAL-6's `terminate` strategy (which only flips runs.status
 *      directly; the underlying Temporal workflow keeps running and its
 *      try/finally still calls this normally).
 *   2. RunLauncherService.cancelRun -- when durable.terminateWorkflow
 *      actually succeeds, it hard-kills the workflow execution and
 *      finalizeRun's try/finally NEVER runs. Needs its own write.
 *   3. RunLauncherService.startAndTransition's catch block -- a run whose
 *      Temporal workflow never even started. No Executor try/finally will
 *      ever fire for it either.
 *
 * Idempotent via ON CONFLICT DO NOTHING on (tenant_id, run_id) --
 * whichever real path's write lands first wins; a second path racing in
 * afterward (e.g. cancelRun's comment about racing finalizeRun) is a
 * silent no-op, never a duplicate or overwritten verdict.
 */

export type RunOutcomeVerdict =
  | "completed_verified"
  | "rescued"
  | "escalated"
  | "failed"
  | "abandoned"
  | "degraded";

export interface RunOutcomeTransaction {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface RunOutcomeTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (transaction: RunOutcomeTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface RunOutcomeRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly mode: string;
  readonly eligible: boolean;
  readonly verdict: string;
  readonly human_rescue: boolean;
  readonly critical_external_error: boolean;
  readonly gates_passed: number;
  readonly gates_failed: number;
  readonly recovery_count: number;
  readonly human_repair_after_complete: boolean | null;
  readonly decided_at: string;
}

export interface RunLearningNodeSummary extends Record<string, unknown> {
  readonly node_execution_id: string;
  readonly node_key: string;
  readonly node_type: string;
  readonly status: string;
  readonly attempt: number;
  readonly input_ref: string | null;
  readonly output_ref: string | null;
  readonly error_code: string | null;
}

export interface RunLearningRecoverySummary extends Record<string, unknown> {
  readonly node_execution_id: string | null;
  readonly failure_class: string;
  readonly strategy: string;
  readonly outcome: string | null;
}

export interface RunLearningSummary {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly verdict: string;
  readonly gates_passed: number;
  readonly gates_failed: number;
  readonly recovery_count: number;
  readonly nodes: readonly RunLearningNodeSummary[];
  readonly recovery_actions: readonly RunLearningRecoverySummary[];
}

interface RunRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly parent_kind: string;
  readonly workflow_version_id: string | null;
  readonly status: string;
}

export class RunOutcomeRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = "RunOutcomeRunNotFoundError";
  }
}

export class RunOutcomeNotCompletedError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} has no completed outcome`);
    this.name = "RunOutcomeNotCompletedError";
  }
}

export class RunOutcomeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunOutcomeValidationError";
  }
}

function bareTenantUuid(tenantIdInput: string): string {
  const parsed = TenantIdSchema.safeParse(tenantIdInput);
  if (!parsed.success) {
    throw new RunOutcomeValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** The Cost Ledger's run-verdict intake (design log §21), narrowed to what this needs. */
export interface RunVerdictSink {
  recordRunVerdict(request: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly verdict: string;
    readonly decided_at: string;
  }): Promise<unknown>;
}

export class RunOutcomeService {
  readonly #logger = new Logger(RunOutcomeService.name);

  constructor(
    private readonly store: RunOutcomeTenantStore,
    private readonly verdictSink?: RunVerdictSink,
  ) {}

  /**
   * `terminalRunStatus` is the real, already-resolved `runs.status` at the
   * moment this is called (never re-derived) -- callers pass whichever
   * value their own real terminal write already landed, so this never
   * races against or second-guesses the actual source of truth.
   */
  async recordOutcome(
    tenantIdInput: string,
    runId: string,
    terminalRunStatus: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const tenantId = bareTenantUuid(tenantIdInput);
    if (!RunIdSchema.safeParse(runId).success) {
      throw new RunOutcomeValidationError("runId must be a run_ prefixed UUIDv7");
    }
    const recorded = await this.store.withTenant(tenantId, async (tx) => {
      const run = await this.#loadRun(tx, tenantId, runId);
      const eligible = await this.#isEligible(tx, tenantId, run.workflow_version_id);
      const gates = await this.#countGates(tx, tenantId, runId);
      const recovery = await this.#inspectRecovery(tx, tenantId, runId);
      const criticalExternalError = await this.#hasCriticalSafetyFailure(
        tx,
        tenantId,
        runId,
      );
      const verdict = decideVerdict(terminalRunStatus, recovery);

      await tx.query(
        `INSERT INTO run_outcomes
           (id, tenant_id, workspace_id, run_id, mode, eligible, verdict,
            human_rescue, critical_external_error, gates_passed, gates_failed,
            recovery_count, human_repair_after_complete, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, clock_timestamp())
         ON CONFLICT (tenant_id, run_id) DO NOTHING`,
        [
          randomUUID(),
          tenantId,
          run.workspace_id,
          runId,
          run.parent_kind, // Project runs have no workflow version, so eligibility remains false.
          eligible,
          verdict,
          recovery.humanRescue,
          criticalExternalError,
          gates.passed,
          gates.failed,
          recovery.count,
        ],
      );
      // The outcome as stored -- a replayed finalize keeps the first one.
      const stored = await tx.query<{ readonly verdict: string; readonly decided_at: string }>(
        `SELECT verdict, to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
         FROM run_outcomes WHERE tenant_id = $1 AND run_id = $2`,
        [tenantId, runId],
      );
      return stored.rows[0];
    });
    if (recorded !== undefined) {
      await this.#sendVerdictBestEffort(tenantIdInput, runId, recorded);
    }
  }

  /**
   * Design log §21 / §22 item 10: the Cost Ledger records each run's verdict
   * beside its cost, because verified-run billing charges only runs that
   * pass. Sent after the outcome commits and never allowed to fail the run's
   * finalization; the ledger's intake is idempotent, so a resend is safe.
   */
  async #sendVerdictBestEffort(
    tenantId: string,
    runId: string,
    outcome: { readonly verdict: string; readonly decided_at: string },
  ): Promise<void> {
    if (this.verdictSink === undefined) return;
    try {
      await this.verdictSink.recordRunVerdict({
        tenant_id: tenantId,
        run_id: runId,
        verdict: outcome.verdict,
        decided_at: outcome.decided_at,
      });
    } catch (error: unknown) {
      this.#logger.error({
        message: "run verdict could not be recorded in the Cost Ledger",
        runId,
        verdict: outcome.verdict,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Real backing for `GET /runs/{id}/outcome` (doc 05). */
  async getByRunId(
    tenantIdInput: string,
    runId: string,
  ): Promise<RunOutcomeRow | undefined> {
    const tenantId = bareTenantUuid(tenantIdInput);
    if (!RunIdSchema.safeParse(runId).success) {
      throw new RunOutcomeValidationError("runId must be a run_ prefixed UUIDv7");
    }
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<RunOutcomeRow>(
        `SELECT run_id, mode, eligible, verdict, human_rescue,
                critical_external_error, gates_passed, gates_failed,
                recovery_count, human_repair_after_complete,
                decided_at::text
         FROM run_outcomes WHERE tenant_id = $1 AND run_id = $2`,
        [tenantId, runId],
      );
      return result.rows[0];
    });
  }

  /**
   * Minimal tenant-scoped projection for KNOW-13 post-run learning.
   * Raw node error details are deliberately not exposed: only their code
   * crosses the service boundary, avoiding accidental secret propagation.
   */
  async getLearningSummary(
    tenantIdInput: string,
    runId: string,
  ): Promise<RunLearningSummary> {
    const tenantId = bareTenantUuid(tenantIdInput);
    if (!RunIdSchema.safeParse(runId).success) {
      throw new RunOutcomeValidationError("runId must be a run_ prefixed UUIDv7");
    }
    return this.store.withTenant(tenantId, async (tx) => {
      const run = await this.#loadRun(tx, tenantId, runId);
      if (!isTerminalRunStatus(run.status)) {
        throw new RunOutcomeNotCompletedError(runId);
      }

      const outcome = await tx.query<RunOutcomeRow>(
        `SELECT run_id, mode, eligible, verdict, human_rescue,
                critical_external_error, gates_passed, gates_failed,
                recovery_count, human_repair_after_complete,
                decided_at::text
         FROM run_outcomes WHERE tenant_id = $1 AND run_id = $2`,
        [tenantId, runId],
      );
      const outcomeRow = outcome.rows[0];
      if (outcomeRow === undefined) {
        throw new RunOutcomeNotCompletedError(runId);
      }

      const nodes = await tx.query<RunLearningNodeSummary>(
        `SELECT id AS node_execution_id, dag_node_id AS node_key, node_type,
                status, attempt, input_ref, output_ref, error->>'code' AS error_code
         FROM node_executions
         WHERE tenant_id = $1 AND run_id = $2
         ORDER BY started_at ASC, id ASC`,
        [tenantId, runId],
      );
      const recoveryActions = await tx.query<RunLearningRecoverySummary>(
        `SELECT node_execution_id, failure_class, strategy, outcome
         FROM recovery_actions
         WHERE tenant_id = $1 AND run_id = $2
         ORDER BY created_at ASC, id ASC`,
        [tenantId, runId],
      );

      return {
        tenant_id: tenantIdInput,
        run_id: runId,
        workspace_id: `ws_${run.workspace_id}`,
        verdict: outcomeRow.verdict,
        gates_passed: outcomeRow.gates_passed,
        gates_failed: outcomeRow.gates_failed,
        recovery_count: outcomeRow.recovery_count,
        nodes: nodes.rows,
        recovery_actions: recoveryActions.rows,
      };
    });
  }

  async #loadRun(
    tx: RunOutcomeTransaction,
    tenantId: string,
    runId: string,
  ): Promise<RunRow> {
    const result = await tx.query<RunRow>(
      `SELECT workspace_id::text, parent_kind, workflow_version_id, status
       FROM runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new RunOutcomeRunNotFoundError(runId);
    return row;
  }

  /**
   * "Eligible = past production approval" (doc 04 §3 VACR/VADR
   * denominator law). workflow_versions.status lifecycle is
   * compiled -> canary -> promoted -> rolled_back/retired (PLAN-11).
   * "Past production approval" is read here as: reached (or had reached)
   * the real production-approved state -- 'promoted' now, or
   * 'rolled_back' (which only happens to a version that WAS promoted).
   * 'compiled'/'canary'/'retired' have not cleared that gate. Disclosed
   * interpretation -- doc 04 does not spell out this exact mapping.
   */
  async #isEligible(
    tx: RunOutcomeTransaction,
    tenantId: string,
    workflowVersionId: string | null,
  ): Promise<boolean> {
    if (workflowVersionId === null) return false;
    const result = await tx.query<{ readonly status: string }>(
      `SELECT status FROM workflow_versions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, workflowVersionId],
    );
    const status = result.rows[0]?.status;
    return status === "promoted" || status === "rolled_back";
  }

  async #countGates(
    tx: RunOutcomeTransaction,
    tenantId: string,
    runId: string,
  ): Promise<{ readonly passed: number; readonly failed: number }> {
    const result = await tx.query<{ readonly verdict: string; readonly count: string }>(
      `SELECT verdict, COUNT(*)::text AS count
       FROM verification_results
       WHERE tenant_id = $1 AND run_id = $2
       GROUP BY verdict`,
      [tenantId, runId],
    );
    let passed = 0;
    let failed = 0;
    for (const row of result.rows) {
      const count = Number(row.count);
      if (row.verdict === "pass") passed += count;
      else failed += count; // 'fail' and 'warn' both count against gates_failed
    }
    return { passed, failed };
  }

  /**
   * human_rescue: a real ask_user recovery_action that was actually
   * resolved (outcome = 'resolved') for this run. Known gap (disclosed in
   * HEAL-6 PR A): nothing yet calls RecordOutcome to flip ask_user's
   * initial 'escalated' outcome to 'resolved' once a human decides -- so
   * this will almost always compute false today, correctly reflecting
   * that the real HEAL-7-decision-to-RecordOutcome wiring doesn't exist
   * yet, not a bug in this ticket.
   */
  async #inspectRecovery(
    tx: RunOutcomeTransaction,
    tenantId: string,
    runId: string,
  ): Promise<{
    readonly count: number;
    readonly humanRescue: boolean;
    readonly anyResolved: boolean;
    readonly anyDegradeResolved: boolean;
    readonly anyEscalatedUnresolved: boolean;
  }> {
    const result = await tx.query<{
      readonly strategy: string | null;
      readonly outcome: string | null;
    }>(
      `SELECT strategy, outcome FROM recovery_actions
       WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    );
    let anyResolved = false;
    let anyDegradeResolved = false;
    let anyEscalatedUnresolved = false;
    let humanRescue = false;
    for (const row of result.rows) {
      if (row.outcome === "resolved") {
        anyResolved = true;
        if (row.strategy === "degrade") anyDegradeResolved = true;
        if (row.strategy === "ask_user") humanRescue = true;
      }
      if (row.strategy === "ask_user" && row.outcome === "escalated") {
        anyEscalatedUnresolved = true;
      }
    }
    return {
      count: result.rows.length,
      humanRescue,
      anyResolved,
      anyDegradeResolved,
      anyEscalatedUnresolved,
    };
  }

  /**
   * critical_external_error: a real safety-gate failure was recorded for
   * this run. "Verification precedes every external action" (HEAL-4) means
   * this should be exceedingly rare in practice -- if it is ever true
   * alongside evidence an external action actually happened, that is a
   * signal for the guardrail this field exists to track (doc 01 "critical
   * customer-visible error <0.1%"), not something this ticket resolves.
   */
  async #hasCriticalSafetyFailure(
    tx: RunOutcomeTransaction,
    tenantId: string,
    runId: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM verification_results
       WHERE tenant_id = $1 AND run_id = $2 AND gate_type = 'safety' AND verdict = 'fail'
       LIMIT 1`,
      [tenantId, runId],
    );
    return result.rowCount > 0;
  }
}

function decideVerdict(
  terminalRunStatus: "completed" | "failed" | "cancelled",
  recovery: {
    readonly count: number;
    readonly anyResolved: boolean;
    readonly anyDegradeResolved: boolean;
    readonly anyEscalatedUnresolved: boolean;
  },
): RunOutcomeVerdict {
  if (terminalRunStatus === "cancelled") return "abandoned";
  if (terminalRunStatus === "completed") {
    if (recovery.anyDegradeResolved) return "degraded";
    if (recovery.anyResolved) return "rescued";
    return "completed_verified";
  }
  // terminalRunStatus === "failed"
  if (recovery.anyEscalatedUnresolved) return "escalated";
  return "failed";
}
