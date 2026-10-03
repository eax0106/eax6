import { randomUUID } from "node:crypto";

import { EscalationIdSchema, TenantIdSchema } from "@alterx/contracts";

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

export class EscalationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscalationValidationError";
  }
}

export class EscalationNotFoundError extends Error {
  constructor(escalationId: string) {
    super(`Escalation ${escalationId} was not found`);
    this.name = "EscalationNotFoundError";
  }
}

export class EscalationStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscalationStateConflictError";
  }
}

export interface EscalationRow extends Record<string, unknown> {
  readonly id: string;
  readonly run_id: string;
  readonly node_execution_id: string | null;
  readonly recovery_action_id: string;
  readonly reason: string;
  readonly status: string;
  // ENGINE-FIX-P5-1b: additive, consumed by platform-api's workspace-bound
  // RBAC resolver via the escalation read response.
  readonly workspace_id?: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
  readonly resolution_note: string | null;
  readonly created_at: string;
}

export interface EscalationPage {
  readonly data: readonly EscalationRow[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new EscalationValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function requireEscalationId(escalationId: string): void {
  if (!EscalationIdSchema.safeParse(escalationId).success) {
    throw new EscalationValidationError("escalationId must be an esc_ prefixed UUIDv7");
  }
}

export function newEscalationId(): string {
  const id = randomUUID();
  return `esc_${id.slice(0, 14)}7${id.slice(15)}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new EscalationValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

const ESCALATION_SELECT_COLUMNS = `id, run_id, node_execution_id, recovery_action_id, reason,
       status, workspace_id, claimed_by::text, claimed_at::text, resolved_by::text,
       resolved_at::text, resolution_note, created_at::text`;

/**
 * Owns the `escalations` table. Rows are created by
 * RecoveryPolicyService.recordOutcome() whenever a real recovery_actions
 * row is recorded as outcome='escalated' -- a recovery strategy gave up
 * and needs real human attention (HAC's escalation queue, doc 12
 * Product Core Phase). Mirrors ApprovalsService's real claim/resolve
 * shape; unlike approvals, resolving an escalation does not signal a
 * waiting workflow -- there is no real workflow-resume contract for a
 * recovery-exhausted escalation yet, so resolve() only records the real
 * human decision, disclosed here rather than faked as an automatic
 * resume.
 */
/** The one signal this service sends: the same one the `retry` strategy sends. */
export interface EscalationRetrySignaler {
  signalWorkflow(request: {
    readonly workflowId: string;
    readonly signalName: string;
    readonly payload: unknown;
  }): Promise<void>;
}

export class EscalationsService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    // Optional: a deployment or test with no durable provider still records
    // every human decision, it just cannot wake a parked run.
    private readonly retrySignaler?: EscalationRetrySignaler,
  ) {}

  async create(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly nodeExecutionId: string | undefined;
    readonly recoveryActionId: string;
    readonly reason: string;
  }): Promise<EscalationRow> {
    const tenantId = bareTenantUuid(input.tenantId);
    const id = newEscalationId();
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<EscalationRow>(
        `INSERT INTO escalations
           (id, tenant_id, workspace_id, run_id, node_execution_id, recovery_action_id, reason, status)
         SELECT $1, $2, workspace_id, $3, $4, $5, $6, 'open'
         FROM runs
         WHERE tenant_id = $2 AND id = $3
         RETURNING ${ESCALATION_SELECT_COLUMNS}`,
        [id, tenantId, input.runId, input.nodeExecutionId ?? null, input.recoveryActionId, input.reason],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new EscalationValidationError(`run ${input.runId} was not found for this tenant`);
      }
      return row;
    });
  }

  async getById(tenantIdInput: string, escalationId: string): Promise<EscalationRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireEscalationId(escalationId);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<EscalationRow>(
        `SELECT ${ESCALATION_SELECT_COLUMNS} FROM escalations WHERE tenant_id = $1 AND id = $2`,
        [tenantId, escalationId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new EscalationNotFoundError(escalationId);
      return row;
    });
  }

  async list(
    tenantIdInput: string,
    query: { readonly workspaceId?: string; readonly status?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<EscalationPage> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const limit = normalizeLimit(query.limit);

    return this.store.withTenant(tenantId, async (tx) => {
      const conditions: string[] = ["tenant_id = $1"];
      const values: unknown[] = [tenantId];
      if (query.workspaceId !== undefined) {
        values.push(query.workspaceId);
        conditions.push(`workspace_id = $${values.length}`);
      }
      if (query.status !== undefined) {
        values.push(query.status);
        conditions.push(`status = $${values.length}`);
      }
      if (query.cursor !== undefined) {
        requireEscalationId(query.cursor);
        const cursorRow = await tx.query<{ readonly created_at: string }>(
          "SELECT created_at::text FROM escalations WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR workspace_id = $3)",
          [tenantId, query.cursor, query.workspaceId ?? null],
        );
        const createdAt = cursorRow.rows[0]?.created_at;
        if (createdAt === undefined) {
          throw new EscalationValidationError("cursor does not belong to this tenant");
        }
        values.push(createdAt, query.cursor);
        conditions.push(`(created_at, id) > ($${values.length - 1}::timestamptz, $${values.length})`);
      }

      values.push(limit + 1);
      const result = await tx.query<EscalationRow>(
        `SELECT ${ESCALATION_SELECT_COLUMNS}
         FROM escalations WHERE ${conditions.join(" AND ")}
         ORDER BY created_at ASC, id ASC
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

  async claim(
    tenantIdInput: string,
    escalationId: string,
    claimedBy: string | undefined,
  ): Promise<EscalationRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireEscalationId(escalationId);
    return this.store.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<EscalationRow>(
        `UPDATE escalations
         SET status = 'claimed', claimed_by = $3, claimed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'open'
         RETURNING ${ESCALATION_SELECT_COLUMNS}`,
        [tenantId, escalationId, claimedBy ?? null],
      );
      const row = updated.rows[0];
      if (row !== undefined) return row;

      const existing = await tx.query<{ readonly status: string }>(
        `SELECT status FROM escalations WHERE tenant_id = $1 AND id = $2`,
        [tenantId, escalationId],
      );
      if (existing.rows[0] === undefined) throw new EscalationNotFoundError(escalationId);
      throw new EscalationStateConflictError(
        `escalation ${escalationId} is already "${existing.rows[0].status}" and cannot be claimed`,
      );
    });
  }

  /**
   * Decision 6: an escalation raised by "repair" is the one kind whose
   * resolution means something a run can act on -- a person has connected
   * the account the step needed, so the step can run again. The run has been
   * parked all along inside the Executor's own 24-hour wait for a
   * `nodeRetryDecided` signal, so resolving sends exactly that signal, the
   * same one the `retry` strategy sends.
   *
   * Signalled before the row is committed, for the reason
   * ApprovalsService.decide gives: if the signal fails, the escalation stays
   * open and the whole call can be retried, rather than a resolved
   * escalation sitting beside a run that never heard about it.
   *
   * Every other escalation still resolves without signalling anything. A
   * strategy that exhausted itself has no step waiting to be re-run, and
   * telling a workflow to retry on the strength of a human's note would be
   * inventing a contract that does not exist.
   */
  async resolve(
    tenantIdInput: string,
    escalationId: string,
    resolvedBy: string | undefined,
    note: string | undefined,
  ): Promise<EscalationRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireEscalationId(escalationId);

    const current = await this.getById(tenantIdInput, escalationId);
    if (current.status === "open" || current.status === "claimed") {
      await this.#resumeParkedRun(tenantId, current);
    }

    return this.store.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<EscalationRow>(
        `UPDATE escalations
         SET status = 'resolved', resolved_by = $3, resolved_at = clock_timestamp(), resolution_note = $4
         WHERE tenant_id = $1 AND id = $2 AND status IN ('open', 'claimed')
         RETURNING ${ESCALATION_SELECT_COLUMNS}`,
        [tenantId, escalationId, resolvedBy ?? null, note ?? null],
      );
      const row = updated.rows[0];
      if (row !== undefined) return row;

      const existing = await tx.query<{ readonly status: string }>(
        `SELECT status FROM escalations WHERE tenant_id = $1 AND id = $2`,
        [tenantId, escalationId],
      );
      if (existing.rows[0] === undefined) throw new EscalationNotFoundError(escalationId);
      throw new EscalationStateConflictError(
        `escalation ${escalationId} is already "${existing.rows[0].status}" and cannot be resolved again`,
      );
    });
  }

  /**
   * Sends the parked run's failed step back to the Executor, but only for an
   * escalation that "repair" raised: the strategy on the linked
   * recovery_actions row is what says so, so no new column is needed to tell
   * the two kinds apart.
   */
  async #resumeParkedRun(tenantId: string, escalation: EscalationRow): Promise<void> {
    if (this.retrySignaler === undefined) return;
    if (escalation.node_execution_id === null) return;

    const strategy = await this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ readonly strategy: string | null }>(
        "SELECT strategy FROM recovery_actions WHERE tenant_id = $1 AND id = $2",
        [tenantId, escalation.recovery_action_id],
      );
      return result.rows[0]?.strategy ?? null;
    });
    if (strategy !== "repair") return;

    await this.retrySignaler.signalWorkflow({
      workflowId: escalation.run_id,
      signalName: "nodeRetryDecided",
      payload: {
        nodeExecutionId: escalation.node_execution_id,
        action: "retry",
      },
    });
  }
}
