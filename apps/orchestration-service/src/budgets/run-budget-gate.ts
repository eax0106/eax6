import type { CompiledDag } from "@alterx/contracts";

import type { OrchestrationTransactionLike } from "../runs/run-launcher.service";
import type { EngineBudgetService } from "./budget.service";

/**
 * D4: the worst case a run could cost, in INR paise, worked out from its
 * compiled DAG before it starts. Until the estimator is built the answer is
 * zero: the run is still refused once a budget's spent money has used up the
 * cap, it just does not reserve anything ahead.
 */
export interface RunCostEstimator {
  estimateMinor(input: { readonly tenantId: string; readonly workflowId: string; readonly compiledDag: CompiledDag }): Promise<number>;
}

export const zeroRunCostEstimator: RunCostEstimator = { estimateMinor: async () => 0 };

/** What the Cost Ledger says the run has cost, billed (margin applied once). */
export interface RunCostReader {
  billableMinor(input: { readonly tenantId: string; readonly workspaceId: string; readonly runId: string }): Promise<number>;
}

export interface RunBudgetSettlement {
  settle(input: { readonly tenantId: string; readonly workspaceId: string; readonly runId: string }): Promise<void>;
}

/**
 * Joins the budget store to a run's two edges: the start (reserve the worst
 * case inside the run's own transaction, so a refused run leaves no row) and
 * the end (true the reservation up to what the run really cost).
 */
export class RunBudgetGate implements RunBudgetSettlement {
  constructor(
    private readonly budgets: EngineBudgetService,
    private readonly reader: RunCostReader,
    private readonly estimator: RunCostEstimator = zeroRunCostEstimator,
  ) {}

  async reserve(
    tx: OrchestrationTransactionLike,
    input: {
      readonly tenantId: string;
      readonly workspaceId: string;
      readonly workflowId: string;
      readonly runId: string;
      readonly compiledDag: CompiledDag;
    },
  ): Promise<void> {
    const amountMinor = await this.estimator.estimateMinor({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      compiledDag: input.compiledDag,
    });
    await this.budgets.reserve(tx, {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      amountMinor,
    });
  }

  async settle(input: { readonly tenantId: string; readonly workspaceId: string; readonly runId: string }): Promise<void> {
    await this.settleOne(input);
    // A settle that failed at an earlier run's end left that run's reservation
    // held; it is retried here, when the next run of the tenant ends.
    const unsettled = await this.budgets.unsettledEndedRuns(input.tenantId, input.runId, UNSETTLED_RETRY_LIMIT);
    for (const run of unsettled) {
      try {
        await this.settleOne({ tenantId: input.tenantId, workspaceId: run.workspace_id, runId: run.run_id });
      } catch {
        // Still unsettled: the next run's end tries again.
      }
    }
  }

  private async settleOne(input: { readonly tenantId: string; readonly workspaceId: string; readonly runId: string }): Promise<void> {
    // The engine keeps bare uuids in its tables; the Cost Ledger speaks prefixed ids.
    const actualMinor = await this.reader.billableMinor({
      tenantId: withPrefix("ten_", input.tenantId),
      workspaceId: withPrefix("ws_", input.workspaceId),
      runId: input.runId,
    });
    await this.budgets.settle(input.tenantId, input.runId, actualMinor);
  }
}

/** How many earlier unsettled runs one run's end retries. */
const UNSETTLED_RETRY_LIMIT = 20;

function withPrefix(prefix: string, id: string): string {
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}
