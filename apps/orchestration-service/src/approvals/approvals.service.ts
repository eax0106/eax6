import { randomUUID } from "node:crypto";

import { ApprovalIdSchema, TenantIdSchema } from "@alterx/contracts";

import { appliedPolicy, countDecision } from "./approval-policy.service";

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

export class ApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalValidationError";
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`Approval ${approvalId} was not found`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalStateConflictError";
  }
}

export interface ApprovalRow extends Record<string, unknown> {
  readonly id: string;
  readonly run_id: string;
  readonly node_execution_id: string;
  readonly requested_action: Record<string, unknown>;
  readonly status: string;
  // ENGINE-FIX-P5-1b: additive, consumed by platform-api's workspace-bound
  // RBAC resolver via the approval read response.
  readonly workspace_id?: string;
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly decision_note: string | null;
  readonly expiry_at: string;
  // D5: the mode used for this approval and who set it (null: the default).
  readonly workflow_id?: string | null;
  readonly node_key?: string | null;
  readonly mode?: string;
  readonly policy_set_by?: string | null;
}

export interface ApprovalPage {
  readonly data: readonly ApprovalRow[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new ApprovalValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function newApprovalId(): string {
  const id = randomUUID();
  return `apr_${id.slice(0, 14)}7${id.slice(15)}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApprovalValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

const APPROVAL_SELECT_COLUMNS = `id, run_id, node_execution_id, requested_action, status, workspace_id,
       requested_at::text, decided_at::text, decided_by::text, decision_note,
       expiry_at::text, mode, policy_set_by,
       (SELECT r.workflow_id FROM runs r WHERE r.tenant_id = approvals.tenant_id AND r.id = approvals.run_id) AS workflow_id,
       (SELECT n.dag_node_id FROM node_executions n WHERE n.tenant_id = approvals.tenant_id AND n.id = approvals.node_execution_id) AS node_key`;

export interface CreatePendingApprovalRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly nodeExecutionId: string;
  readonly requestedAction: Record<string, unknown>;
  readonly expirySeconds: number;
}

export interface CreatedApproval {
  readonly id: string;
  readonly expiryAt: string;
  readonly mode: "ask" | "auto";
  readonly policySetBy: string | null;
  readonly skipOnTimeout: boolean;
}

export interface ApprovalDecisionSignaler {
  signalWorkflow(request: {
    readonly workflowId: string;
    readonly signalName: string;
    readonly payload: unknown;
  }): Promise<void>;
}

/**
 * Owns the `approvals` table (doc 04 §3). A HumanApproval node persists its
 * request here (status=pending); the executor workflow durably waits on it
 * (HEAL-7); the /approvals REST API decides it, which in turn signals the
 * waiting Temporal workflow (workflowId = run_id, matching every other
 * run-scoped signal/terminate call in this codebase).
 */
export class ApprovalsService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly durable: ApprovalDecisionSignaler,
  ) {}

  /**
   * D5: applies the step's mode. "Always go ahead" records the approval as
   * approved by policy at once, so the node does not wait; "Ask me first"
   * stays pending, using the step's own window when it skips on timeout.
   */
  async createPending(
    request: CreatePendingApprovalRequest,
  ): Promise<CreatedApproval> {
    const tenantId = bareTenantUuid(request.tenantId);
    if (!Number.isFinite(request.expirySeconds) || request.expirySeconds <= 0) {
      throw new ApprovalValidationError("expirySeconds must be a positive number");
    }
    const id = newApprovalId();

    return this.store.withTenant(tenantId, async (tx) => {
      const policy = await appliedPolicy(tx, tenantId, request.runId, request.nodeExecutionId);
      const auto = policy.mode === "auto";
      const expirySeconds = !auto && policy.timeoutSeconds !== null ? policy.timeoutSeconds : request.expirySeconds;
      const result = await tx.query<{ readonly expiry_at: string }>(
        `INSERT INTO approvals
           (id, tenant_id, workspace_id, run_id, node_execution_id, requested_action, status, expiry_at,
            mode, policy_set_by, decided_at, decision_note)
         SELECT $1, $2, workspace_id, $3, $4, $5::jsonb, $7,
                clock_timestamp() + make_interval(secs => $6), $8, $9,
                CASE WHEN $8 = 'auto' THEN clock_timestamp() END,
                CASE WHEN $8 = 'auto' THEN 'approved by policy' END
         FROM runs
         WHERE tenant_id = $2 AND id = $3
         RETURNING expiry_at::text`,
        [
          id,
          tenantId,
          request.runId,
          request.nodeExecutionId,
          JSON.stringify(request.requestedAction),
          expirySeconds,
          auto ? "approved" : "pending",
          policy.mode,
          policy.setBy,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ApprovalValidationError(
          `run ${request.runId} was not found for this tenant`,
        );
      }
      return {
        id,
        expiryAt: row.expiry_at,
        mode: policy.mode,
        policySetBy: policy.setBy,
        skipOnTimeout: !auto && policy.skipOnTimeout,
      };
    });
  }

  /**
   * D5 skip-on-timeout: the run went past an unanswered approval. The
   * approval is marked skipped and the run flagged, so it is visible later.
   */
  async markSkipped(tenantIdInput: string, runId: string, nodeExecutionId: string): Promise<void> {
    const tenantId = bareTenantUuid(tenantIdInput);
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE approvals SET status = 'skipped'
          WHERE tenant_id = $1 AND run_id = $2 AND node_execution_id = $3 AND status IN ('pending', 'expired')`,
        [tenantId, runId, nodeExecutionId],
      );
      await tx.query(
        `UPDATE runs SET flags = array_append(flags, 'approval_skipped')
          WHERE tenant_id = $1 AND id = $2 AND NOT ('approval_skipped' = ANY (flags))`,
        [tenantId, runId],
      );
    });
  }

  async getById(tenantIdInput: string, approvalId: string): Promise<ApprovalRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    if (!ApprovalIdSchema.safeParse(approvalId).success) {
      throw new ApprovalValidationError("approvalId must be an apr_ prefixed UUIDv7");
    }
    return this.store.withTenant(tenantId, async (tx) => {
      const row = await this.#expireIfPast(tx, tenantId, approvalId);
      if (row === undefined) throw new ApprovalNotFoundError(approvalId);
      return row;
    });
  }

  async list(
    tenantIdInput: string,
    query: { readonly status?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<ApprovalPage> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const limit = normalizeLimit(query.limit);

    return this.store.withTenant(tenantId, async (tx) => {
      await this.#expirePastDue(tx, tenantId);

      const conditions: string[] = ["tenant_id = $1"];
      const values: unknown[] = [tenantId];
      if (query.status !== undefined) {
        values.push(query.status);
        conditions.push(`status = $${values.length}`);
      }
      if (query.cursor !== undefined) {
        if (!ApprovalIdSchema.safeParse(query.cursor).success) {
          throw new ApprovalValidationError("cursor must be an apr_ prefixed UUIDv7");
        }
        const cursorRow = await tx.query<{ readonly requested_at: string }>(
          "SELECT requested_at::text FROM approvals WHERE tenant_id = $1 AND id = $2",
          [tenantId, query.cursor],
        );
        const requestedAt = cursorRow.rows[0]?.requested_at;
        if (requestedAt === undefined) {
          throw new ApprovalValidationError("cursor does not belong to this tenant");
        }
        values.push(requestedAt, query.cursor);
        conditions.push(
          `(requested_at, id) > ($${values.length - 1}::timestamptz, $${values.length})`,
        );
      }

      values.push(limit + 1);
      const result = await tx.query<ApprovalRow>(
        `SELECT ${APPROVAL_SELECT_COLUMNS}
         FROM approvals WHERE ${conditions.join(" AND ")}
         ORDER BY requested_at ASC, id ASC
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

  /**
   * Signals the waiting Executor workflow BEFORE committing the DB
   * decision (not inside the same transaction -- a network call must
   * never hold a DB transaction open): if the signal fails, the approval
   * stays 'pending' and the caller can safely retry the whole decide()
   * call. If the signal succeeds but this process crashes before the
   * following UPDATE commits, the approval row would be stuck showing
   * 'pending' even though the workflow already resolved that node --
   * a disclosed, narrow inconsistency window; the workflow's own expiry
   * timeout is the safety net for a decision that never reaches it at
   * all, not for this specific crash window.
   */
  async decide(
    tenantIdInput: string,
    approvalId: string,
    decision: "approved" | "rejected",
    decidedBy: string | undefined,
    note: string | undefined,
  ): Promise<ApprovalRow> {
    const tenantId = bareTenantUuid(tenantIdInput);
    if (!ApprovalIdSchema.safeParse(approvalId).success) {
      throw new ApprovalValidationError("approvalId must be an apr_ prefixed UUIDv7");
    }

    const current = await this.store.withTenant(tenantId, (tx) =>
      this.#expireIfPast(tx, tenantId, approvalId),
    );
    if (current === undefined) throw new ApprovalNotFoundError(approvalId);
    if (current.status !== "pending") {
      throw new ApprovalStateConflictError(
        `approval ${approvalId} is already "${current.status}" and cannot be decided again`,
      );
    }

    await this.durable.signalWorkflow({
      workflowId: current.run_id,
      signalName: "approvalDecided",
      payload: {
        nodeExecutionId: current.node_execution_id,
        approved: decision === "approved",
        ...(note === undefined ? {} : { note }),
      },
    });

    return this.store.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<ApprovalRow>(
        `UPDATE approvals
         SET status = $3, decided_at = clock_timestamp(), decided_by = $4, decision_note = $5
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING ${APPROVAL_SELECT_COLUMNS}`,
        [tenantId, approvalId, decision, decidedBy ?? null, note ?? null],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ApprovalStateConflictError(
          `approval ${approvalId} was decided concurrently by another request`,
        );
      }
      // D5: a person's decision extends or ends the promotion streak.
      await countDecision(tx, tenantId, approvalId, decision);
      return row;
    });
  }

  /** Reads the row and, if past its expiry and still pending, expires it first. */
  async #expireIfPast(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    approvalId: string,
  ): Promise<ApprovalRow | undefined> {
    const expired = await tx.query<ApprovalRow>(
      `UPDATE approvals
       SET status = 'expired'
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND expiry_at < clock_timestamp()
       RETURNING ${APPROVAL_SELECT_COLUMNS}`,
      [tenantId, approvalId],
    );
    if (expired.rows[0] !== undefined) return expired.rows[0];

    const current = await tx.query<ApprovalRow>(
      `SELECT ${APPROVAL_SELECT_COLUMNS} FROM approvals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, approvalId],
    );
    return current.rows[0];
  }

  /** Bulk-expires every past-due pending row for this tenant before a list read. */
  async #expirePastDue(tx: OrchestrationTransactionLike, tenantId: string): Promise<void> {
    await tx.query(
      `UPDATE approvals
       SET status = 'expired'
       WHERE tenant_id = $1 AND status = 'pending' AND expiry_at < clock_timestamp()`,
      [tenantId],
    );
  }
}
