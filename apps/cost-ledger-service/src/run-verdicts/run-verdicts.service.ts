import { Inject, Injectable } from "@nestjs/common";

import {
  IsoTimestampSchema,
  RunIdSchema,
  TenantIdSchema,
  type CostRecordRunVerdictRequest,
  type CostRecordRunVerdictResponse,
} from "@alterx/contracts";

import { COST_STORE_PROVIDER, type CostStoreProvider } from "../database/cost-store.token";

export class RunVerdictValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunVerdictValidationError";
  }
}

/** A run's verdict can be recorded once; a different one later is a conflict. */
export class RunVerdictConflictError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} already has a different recorded verdict`);
    this.name = "RunVerdictConflictError";
  }
}

/** orchestration run_outcomes.verdict, verbatim. */
export const RUN_VERDICTS = [
  "completed_verified",
  "rescued",
  "escalated",
  "failed",
  "abandoned",
  "degraded",
] as const;

/**
 * Design log §21 / §22 item 10: verified-run billing consumes credits only for
 * runs that pass verification, so the ledger records each run's verdict next
 * to its cost from day one -- billing built later reads it here rather than
 * backfilling data that was never captured.
 */
@Injectable()
export class RunVerdictsService {
  constructor(
    @Inject(COST_STORE_PROVIDER)
    private readonly store: CostStoreProvider,
  ) {}

  async recordRunVerdict(
    request: CostRecordRunVerdictRequest,
  ): Promise<CostRecordRunVerdictResponse> {
    if (!TenantIdSchema.safeParse(request.tenant_id).success) {
      throw new RunVerdictValidationError(`Invalid tenant_id: ${request.tenant_id}`);
    }
    if (!RunIdSchema.safeParse(request.run_id).success) {
      throw new RunVerdictValidationError(`Invalid run_id: ${request.run_id}`);
    }
    if (!(RUN_VERDICTS as readonly string[]).includes(request.verdict)) {
      throw new RunVerdictValidationError(
        `verdict must be one of ${RUN_VERDICTS.join(", ")} -- got "${request.verdict}"`,
      );
    }
    if (!IsoTimestampSchema.safeParse(request.decided_at).success) {
      throw new RunVerdictValidationError(`Invalid decided_at: ${request.decided_at}`);
    }
    const tenantId = request.tenant_id.slice("ten_".length);
    const runId = request.run_id.slice("run_".length);

    return this.store.withTenant(tenantId, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO run_verdicts (tenant_id, run_id, verdict, decided_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, run_id) DO NOTHING`,
        [tenantId, runId, request.verdict, request.decided_at],
      );
      if ((inserted.rowCount ?? 0) > 0) return { recorded: true };
      const existing = await tx.query<{ readonly verdict: string }>(
        "SELECT verdict FROM run_verdicts WHERE tenant_id = $1 AND run_id = $2",
        [tenantId, runId],
      );
      if (existing.rows[0]?.verdict !== request.verdict) {
        throw new RunVerdictConflictError(request.run_id);
      }
      return { recorded: false };
    });
  }
}
