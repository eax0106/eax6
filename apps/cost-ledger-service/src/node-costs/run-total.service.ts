import { Inject, Injectable } from "@nestjs/common";

import { COST_STORE_PROVIDER, type CostStoreProvider } from "../database/cost-store.token";
import { applyMargin } from "../rollup/cost-rollup.service";
import { NodeCostValidationError } from "./node-costs.service";

export const RUN_TOTAL_MARGIN_RATE = Symbol("RUN_TOTAL_MARGIN_RATE");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RunTotal {
  /** What the tenant is billed for the run: internal cost with the margin applied once, at the end. */
  readonly billableMinor: string;
  readonly eventCount: string;
}

/**
 * The billed cost of one run so far (D3, D4), for the engine's budgets: it
 * reserves a worst case when a run starts and trues up to this when the run
 * ends. The margin is applied once, to the run's total, never per event.
 */
@Injectable()
export class RunTotalService {
  constructor(
    @Inject(COST_STORE_PROVIDER) private readonly store: CostStoreProvider,
    @Inject(RUN_TOTAL_MARGIN_RATE) private readonly marginRate: number,
  ) {}

  async getForRun(input: {
    readonly tenantId: unknown;
    readonly workspaceId: unknown;
    readonly runId: unknown;
  }): Promise<RunTotal> {
    const tenantId = prefixedUuid(input.tenantId, "ten", "tenantId");
    const workspaceId = prefixedUuid(input.workspaceId, "ws", "workspaceId");
    const runId = prefixedUuid(input.runId, "run", "runId");
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ internal_cost_minor: string; event_count: string }>(
        `SELECT COALESCE(SUM(internal_cost_minor), 0)::text AS internal_cost_minor,
                COUNT(*)::text AS event_count
           FROM cost_events
          WHERE tenant_id = $1 AND workspace_id = $2 AND run_id = $3`,
        [tenantId, workspaceId, runId],
      );
      const row = result.rows[0]!;
      return { billableMinor: applyMargin(row.internal_cost_minor, this.marginRate), eventCount: row.event_count };
    });
  }
}

function prefixedUuid(value: unknown, prefix: string, field: string): string {
  const expected = `${prefix}_`;
  if (typeof value !== "string" || value.length === 0) throw new NodeCostValidationError(`${field} is required`);
  if (!value.startsWith(expected)) throw new NodeCostValidationError(`${field} must have prefix ${expected}`);
  const bare = value.slice(expected.length);
  if (!UUID_PATTERN.test(bare)) throw new NodeCostValidationError(`${field} must be a ${prefix}_ prefixed UUID`);
  return bare;
}
