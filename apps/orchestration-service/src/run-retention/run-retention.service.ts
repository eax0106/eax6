import { eraseRunBillingReservations } from "../billing/billing-account.service";
import type {
  OrchestrationTenantStore,
  OrchestrationTransactionLike,
} from "../runs/run-observability.service";

export const MIN_RUN_RETENTION_DAYS = 7;
export const MAX_RUN_RETENTION_DAYS = 365;
/** A workspace that never chose a setting keeps the longest history allowed. */
export const DEFAULT_RUN_RETENTION_DAYS = MAX_RUN_RETENTION_DAYS;
const SWEEP_BATCH = 500;

export class RunRetentionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRetentionValidationError";
  }
}

export class RunRetentionStaleError extends Error {
  constructor() {
    super("Run-history retention changed since it was read");
    this.name = "RunRetentionStaleError";
  }
}

/** Lowering the setting destroys runs, so it needs an explicit confirmation. */
export class RunRetentionConfirmationRequiredError extends Error {
  constructor(readonly runsToDelete: number) {
    super(`Lowering run-history retention deletes ${runsToDelete} runs; confirm to continue`);
    this.name = "RunRetentionConfirmationRequiredError";
  }
}

export interface RunRetentionSetting {
  readonly retentionDays: number;
  readonly isDefault: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly etag: string;
}

/**
 * Which runs the sweep may delete: finished, older than the window, and not
 * evidence something else still points at -- an artifact a deployment shipped,
 * or the evaluation run behind a tested workflow version. Their dependents
 * (node executions, blackboard, stream events, verification results, recovery
 * actions, outcomes, approvals, escalations, side effects, artifact metadata,
 * budget reservations) go with them through ON DELETE CASCADE; the cost
 * ledger keeps its own records under its own retention.
 *
 * $1 is the bare tenant id; `days_sql` yields the window in days for r.
 */
function eligibleRuns(daysSql: string): string {
  return `
    FROM runs r
   WHERE r.tenant_id = $1
     AND r.status IN ('completed', 'failed', 'cancelled')
     AND COALESCE(r.ended_at, r.created_at) < now() - make_interval(days => ${daysSql})
     AND NOT EXISTS (
       SELECT 1 FROM artifacts a JOIN deployments d ON d.tenant_id = a.tenant_id AND d.artifact_id = a.id
        WHERE a.tenant_id = r.tenant_id AND a.run_id = r.id)
     AND NOT EXISTS (
       SELECT 1 FROM workflow_versions v WHERE v.tenant_id = r.tenant_id AND v.evaluation_run_id = r.id)`;
}

export class RunRetentionService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async get(tenantId: string, workspaceId: string): Promise<RunRetentionSetting> {
    return this.store.withTenant(tenantId, (tx) => readSetting(tx, tenantId, workspaceId));
  }

  /** How many runs a window of `retentionDays` deletes in this workspace now. */
  async preview(tenantId: string, workspaceId: string, retentionDays: number): Promise<number> {
    requireDays(retentionDays);
    return this.store.withTenant(tenantId, (tx) => countEligible(tx, tenantId, workspaceId, retentionDays));
  }

  async set(
    tenantId: string,
    workspaceId: string,
    input: { readonly retentionDays: number; readonly confirmLowering: boolean; readonly updatedBy: string },
    ifMatch: string,
  ): Promise<RunRetentionSetting> {
    requireDays(input.retentionDays);
    return this.store.withTenant(tenantId, async (tx) => {
      // Serialise writers on the workspace's row (or its absence) so the
      // If-Match check and the write cannot interleave.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [tenantId, workspaceId]);
      const current = await readSetting(tx, tenantId, workspaceId);
      if (ifMatch !== current.etag) throw new RunRetentionStaleError();
      if (input.retentionDays < current.retentionDays && !input.confirmLowering) {
        throw new RunRetentionConfirmationRequiredError(
          await countEligible(tx, tenantId, workspaceId, input.retentionDays),
        );
      }
      await tx.query(
        `INSERT INTO workspace_run_retention (tenant_id, workspace_id, retention_days, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (tenant_id, workspace_id)
         DO UPDATE SET retention_days = EXCLUDED.retention_days,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = EXCLUDED.updated_at`,
        [tenantId, workspaceId, input.retentionDays, input.updatedBy],
      );
      return readSetting(tx, tenantId, workspaceId);
    });
  }
}

/**
 * The daily retention sweep's run-history step for one tenant, inside the
 * sweep's tenant transaction. Deletes in batches so one large backlog cannot
 * hold a single huge statement; returns the number of runs deleted.
 */
export async function sweepRunHistory(tx: OrchestrationTransactionLike, tenantId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = await tx.query<{ id: string }>(
      `SELECT r.id
       ${eligibleRuns(`COALESCE((SELECT s.retention_days FROM workspace_run_retention s
                                  WHERE s.tenant_id = r.tenant_id AND s.workspace_id = r.workspace_id), ${DEFAULT_RUN_RETENTION_DAYS})`)}
       ORDER BY r.id
       LIMIT ${SWEEP_BATCH}`,
      [tenantId],
    );
    const ids = batch.rows.map((row) => row.id);
    if (ids.length === 0) return deleted;
    await eraseRunBillingReservations(tx, tenantId, ids);
    // The dispatch queue's run foreign key has no cascade.
    await tx.query("DELETE FROM run_dispatch_queue WHERE tenant_id = $1 AND run_id = ANY($2::text[])", [tenantId, ids]);
    deleted += (await tx.query("DELETE FROM runs WHERE tenant_id = $1 AND id = ANY($2::text[])", [tenantId, ids])).rowCount;
    if (ids.length < SWEEP_BATCH) return deleted;
  }
}

async function readSetting(
  tx: OrchestrationTransactionLike,
  tenantId: string,
  workspaceId: string,
): Promise<RunRetentionSetting> {
  const result = await tx.query<{ retention_days: number; updated_at: Date; updated_by: string }>(
    `SELECT retention_days, updated_at, updated_by FROM workspace_run_retention
      WHERE tenant_id = $1 AND workspace_id = $2`,
    [tenantId, workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      retentionDays: DEFAULT_RUN_RETENTION_DAYS,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
      etag: `"run-retention-default"`,
    };
  }
  const updatedAt = new Date(row.updated_at).toISOString();
  return {
    retentionDays: row.retention_days,
    isDefault: false,
    updatedAt,
    updatedBy: row.updated_by,
    etag: `"run-retention-${row.retention_days}-${updatedAt}"`,
  };
}

async function countEligible(
  tx: OrchestrationTransactionLike,
  tenantId: string,
  workspaceId: string,
  retentionDays: number,
): Promise<number> {
  const result = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n ${eligibleRuns("$3::int")} AND r.workspace_id = $2`,
    [tenantId, workspaceId, retentionDays],
  );
  return result.rows[0]?.n ?? 0;
}

function requireDays(value: number): void {
  if (!Number.isInteger(value) || value < MIN_RUN_RETENTION_DAYS || value > MAX_RUN_RETENTION_DAYS) {
    throw new RunRetentionValidationError(
      `retention_days must be a whole number from ${MIN_RUN_RETENTION_DAYS} to ${MAX_RUN_RETENTION_DAYS}`,
    );
  }
}
