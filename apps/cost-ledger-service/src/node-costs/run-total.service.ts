import { Inject, Injectable } from "@nestjs/common";

import { COST_STORE_PROVIDER, type CostStoreProvider } from "../database/cost-store.token";
import { NodeCostValidationError } from "./node-costs.service";

/** Turns a run's internal cost into what is billed: the margin, applied once. */
export type MarginApplier = (internalCostMinor: string) => string;
export const RUN_TOTAL_MARGIN = Symbol("RUN_TOTAL_MARGIN");

const MAX_RUNS_PER_REQUEST = 200;
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
    @Inject(RUN_TOTAL_MARGIN) private readonly applyMargin: MarginApplier,
  ) {}

  /** What an internal amount is billed at: the margin applied once to it. */
  bill(internalCostMinor: string): string {
    return this.applyMargin(internalCostMinor);
  }

  /**
   * The billed cost of each of several runs, each billed on its own total
   * (D24: what a workflow costs the tenant is the sum of its runs' bills).
   * A run with no cost events is billed zero.
   */
  async getForRuns(input: {
    readonly tenantId: unknown;
    readonly workspaceId: unknown;
    readonly runIds: unknown;
  }): Promise<readonly { readonly runId: string; readonly billableMinor: string }[]> {
    const tenantId = prefixedUuid(input.tenantId, "ten", "tenantId");
    const workspaceId = prefixedUuid(input.workspaceId, "ws", "workspaceId");
    if (!Array.isArray(input.runIds) || input.runIds.length === 0 || input.runIds.length > MAX_RUNS_PER_REQUEST) {
      throw new NodeCostValidationError(`runIds must list from 1 to ${MAX_RUNS_PER_REQUEST} runs`);
    }
    const runIds = [...new Set(input.runIds.map((id) => prefixedUuid(id, "run", "runIds")))];
    const internalByRun = await this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ run_id: string; internal_cost_minor: string }>(
        `SELECT run_id::text, SUM(internal_cost_minor)::text AS internal_cost_minor
           FROM cost_events
          WHERE tenant_id = $1 AND workspace_id = $2 AND run_id = ANY($3::uuid[])
          GROUP BY run_id`,
        [tenantId, workspaceId, runIds],
      );
      return new Map(result.rows.map((row) => [row.run_id, row.internal_cost_minor]));
    });
    return runIds.map((runId) => ({
      runId: `run_${runId}`,
      billableMinor: this.applyMargin(internalByRun.get(runId) ?? "0"),
    }));
  }

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
      return { billableMinor: this.applyMargin(row.internal_cost_minor), eventCount: row.event_count };
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
