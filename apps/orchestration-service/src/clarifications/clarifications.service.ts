import { NodeExecutionIdSchema, RecoveryActionIdSchema, RunIdSchema, TenantIdSchema } from "@alterx/contracts";
import { randomUUID } from "node:crypto";
import type { EscalationRetrySignaler } from "../escalations/escalations.service";

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

export class ClarificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarificationValidationError";
  }
}

export class ClarificationNotFoundError extends Error {
  constructor(clarificationId: string) {
    super(`Clarification ${clarificationId} was not found`);
    this.name = "ClarificationNotFoundError";
  }
}

export class ClarificationStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarificationStateConflictError";
  }
}

export interface ClarificationRow extends Record<string, unknown> {
  readonly id: string;
  readonly conversation_id: string | null;
  readonly run_id?: string | null;
  readonly node_execution_id?: string | null;
  readonly recovery_action_id?: string | null;
  readonly answer?: string | null;
  readonly question: string;
  readonly status: "open" | "answered" | "expired";
  readonly assignee_user_id: string | null;
  readonly assigned_at: string | null;
  readonly requested_at: string;
  readonly answered_at: string | null;
  readonly expiry_at: string;
  // ENGINE-FIX-P5-1b: additive, consumed by platform-api's workspace-bound
  // RBAC resolver via the clarification read response.
  readonly workspace_id?: string;
}

export interface ClarificationPage {
  readonly data: readonly ClarificationRow[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

const SELECT_COLUMNS = `id, conversation_id, question, status, assignee_user_id::text,
       assigned_at::text, requested_at::text, answered_at::text, expiry_at::text, workspace_id,
       recovery_action_id, answer,
       (SELECT a.run_id FROM recovery_actions a WHERE a.tenant_id = clarifications.tenant_id AND a.id = clarifications.recovery_action_id) AS run_id,
       (SELECT a.node_execution_id FROM recovery_actions a WHERE a.tenant_id = clarifications.tenant_id AND a.id = clarifications.recovery_action_id) AS node_execution_id`;

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new ClarificationValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function bareUserUuid(userId: string): string {
  if (!/^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new ClarificationValidationError("assignee_user_id must be a usr_ prefixed UUIDv7");
  }
  return userId.slice("usr_".length);
}

function requireClarificationId(clarificationId: string): void {
  if (!/^clr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clarificationId)) {
    throw new ClarificationValidationError("clarificationId must be a clr_ prefixed UUIDv7");
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ClarificationValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

export class ClarificationsService {
  constructor(private readonly store: OrchestrationTenantStore, private readonly signaler?: EscalationRetrySignaler) {}

  async createRecovery(input: { readonly tenantId: string; readonly runId: string;
    readonly nodeExecutionId: string; readonly recoveryActionId: string }): Promise<ClarificationRow> {
    const tenantId = bareTenantUuid(input.tenantId);
    if (!RunIdSchema.safeParse(input.runId).success || !NodeExecutionIdSchema.safeParse(input.nodeExecutionId).success ||
        !RecoveryActionIdSchema.safeParse(input.recoveryActionId).success) {
      throw new ClarificationValidationError("Recovery clarification requires valid run, node and recovery ids");
    }
    const uuid = randomUUID();
    const id = `clr_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
    return this.store.withTenant(tenantId, async tx => {
      const result = await tx.query<ClarificationRow>(
        `INSERT INTO clarifications (id, tenant_id, workspace_id, conversation_id, recovery_action_id, question, expiry_at)
         SELECT $1, $2, r.workspace_id, r.conversation_id, a.id,
           CASE WHEN a.failure_class = 'target_missing'
             THEN 'The target for this step is missing. Where should it be redirected, or should the target be recreated? Answer, update the workflow target, and start a new run when ready. This run will not repeat the action.'
             ELSE 'The outcome of this action is uncertain. Check the external system and tell us what happened. Answering closes this failed run; Alter will not retry or swap this step.' END,
           clock_timestamp() + make_interval(secs => 86400)
         FROM recovery_actions a JOIN runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
         WHERE a.tenant_id = $2 AND a.id = $3 AND a.run_id = $4 AND a.node_execution_id = $5
           AND a.failure_class IN ('target_missing', 'ambiguous_outcome')
         ON CONFLICT (tenant_id, recovery_action_id) DO UPDATE SET id = clarifications.id
         RETURNING ${SELECT_COLUMNS}`,
        [id, tenantId, input.recoveryActionId, input.runId, input.nodeExecutionId]);
      const row = result.rows[0];
      if (row === undefined) throw new ClarificationValidationError("Recovery action was not found for this run and tenant");
      return row;
    });
  }

  async answerRecovery(tenantIdInput: string, runId: string, clarificationId: string, note: unknown): Promise<ClarificationRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireClarificationId(clarificationId);
    if (!RunIdSchema.safeParse(runId).success || typeof note !== "string" || !note.trim() || note.length > 10_000) {
      throw new ClarificationValidationError("A valid run id and a non-empty answer of at most 10000 characters are required");
    }
    const answer = note.trim();
    return this.store.withTenant(tenantId, async tx => {
      const found = await tx.query<ClarificationRow & { readonly past_due: boolean }>(
        `SELECT ${SELECT_COLUMNS}, expiry_at < clock_timestamp() AS past_due FROM clarifications
         WHERE tenant_id = $1 AND id = $2 AND recovery_action_id IN
           (SELECT id FROM recovery_actions WHERE tenant_id = $1 AND run_id = $3
            AND failure_class IN ('target_missing', 'ambiguous_outcome')) FOR UPDATE`, [tenantId, clarificationId, runId]);
      const row = found.rows[0];
      if (row === undefined) throw new ClarificationNotFoundError(clarificationId);
      if (row.status === "answered" && row.answer === answer) return row;
      if (row.status !== "open" || row.past_due) throw new ClarificationStateConflictError("This clarification is no longer open");
      if (!this.signaler || !row.node_execution_id) throw new Error("Recovery clarification cannot reach its waiting run");
      // A note never authorizes repeating an uncertain external action. The
      // existing idempotent signal ends the failed run without another attempt.
      // Signal failure rolls back the answer so the caller can safely retry.
      await this.signaler.signalWorkflow({ workflowId: runId, signalName: "nodeRetryDecided",
        payload: { nodeExecutionId: row.node_execution_id, action: "give_up" } });
      const updated = await tx.query<ClarificationRow>(`UPDATE clarifications SET answer = $3,
        status = 'answered', answered_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
      [tenantId, clarificationId, answer]);
      return updated.rows[0]!;
    });
  }

  // ENGINE-FIX-P5-1b: single-resource read so platform-api's workspace-bound
  // RBAC resolver can answer "which workspace owns this clarification"
  // through the same public, tenant-scoped surface as its sibling reads.
  async getById(tenantIdInput: string, clarificationIdInput: string): Promise<ClarificationRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireClarificationId(clarificationIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<ClarificationRow>(
        `SELECT ${SELECT_COLUMNS} FROM clarifications WHERE tenant_id = $1 AND id = $2`,
        [tenantId, clarificationIdInput],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ClarificationNotFoundError(clarificationIdInput);
      return row;
    });
  }

  async list(
    tenantIdInput: string,
    query: { readonly workspaceId?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<ClarificationPage> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const limit = normalizeLimit(query.limit);

    return this.store.withTenant(tenantId, async (tx) => {
      await this.#expirePastDue(tx, tenantId, query.workspaceId);
      const values: unknown[] = [tenantId, query.workspaceId ?? null];
      let cursorClause = "";
      if (query.cursor !== undefined) {
        requireClarificationId(query.cursor);
        const cursor = await tx.query<{ readonly requested_at: string }>(
          "SELECT requested_at::text FROM clarifications WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR workspace_id = $3)",
          [tenantId, query.cursor, query.workspaceId ?? null],
        );
        const requestedAt = cursor.rows[0]?.requested_at;
        if (requestedAt === undefined) {
          throw new ClarificationValidationError("cursor does not belong to this tenant");
        }
        values.push(requestedAt, query.cursor);
        cursorClause = ` AND (requested_at, id) > ($${values.length - 1}::timestamptz, $${values.length})`;
      }
      values.push(limit + 1);
      const rows = await tx.query<ClarificationRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM clarifications
         WHERE tenant_id = $1 AND ($2::uuid IS NULL OR workspace_id = $2) AND status = 'open'${cursorClause}
         ORDER BY requested_at ASC, id ASC
         LIMIT $${values.length}`,
        values,
      );
      const pageRows = [...rows.rows];
      const hasMore = pageRows.length > limit;
      const data = hasMore ? pageRows.slice(0, limit) : pageRows;
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

  async assign(
    tenantIdInput: string,
    clarificationId: string,
    assigneeUserId: string | null,
  ): Promise<ClarificationRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireClarificationId(clarificationId);
    const assignee = assigneeUserId === null ? null : bareUserUuid(assigneeUserId);

    return this.store.withTenant(tenantId, async (tx) => {
      await this.#expireIfPast(tx, tenantId, clarificationId);
      const updated = await tx.query<ClarificationRow>(
        `UPDATE clarifications
         SET assignee_user_id = $3,
             assigned_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE clock_timestamp() END
         WHERE tenant_id = $1 AND id = $2 AND status = 'open'
         RETURNING ${SELECT_COLUMNS}`,
        [tenantId, clarificationId, assignee],
      );
      const row = updated.rows[0];
      if (row !== undefined) return row;

      const current = await this.#find(tx, tenantId, clarificationId);
      if (current === undefined) throw new ClarificationNotFoundError(clarificationId);
      throw new ClarificationStateConflictError(
        `clarification ${clarificationId} is already "${current.status}" and cannot be assigned`,
      );
    });
  }

  async #expirePastDue(tx: OrchestrationTransactionLike, tenantId: string, workspaceId?: string): Promise<void> {
    await tx.query(
      `UPDATE clarifications
       SET status = 'expired'
       WHERE tenant_id = $1 AND status = 'open' AND expiry_at < clock_timestamp() AND ($2::uuid IS NULL OR workspace_id = $2)`,
      [tenantId, workspaceId ?? null],
    );
  }

  async #expireIfPast(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    clarificationId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE clarifications
       SET status = 'expired'
       WHERE tenant_id = $1 AND id = $2 AND status = 'open' AND expiry_at < clock_timestamp()`,
      [tenantId, clarificationId],
    );
  }

  async #find(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    clarificationId: string,
  ): Promise<ClarificationRow | undefined> {
    const result = await tx.query<ClarificationRow>(
      `SELECT ${SELECT_COLUMNS} FROM clarifications WHERE tenant_id = $1 AND id = $2`,
      [tenantId, clarificationId],
    );
    return result.rows[0];
  }
}
