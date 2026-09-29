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
    // The engine keeps bare uuids in its tables; the Cost Ledger speaks prefixed ids.
    const actualMinor = await this.reader.billableMinor({
      tenantId: withPrefix("ten_", input.tenantId),
      workspaceId: withPrefix("ws_", input.workspaceId),
      runId: input.runId,
    });
    await this.budgets.settle(input.tenantId, input.runId, actualMinor);
  }
}

function withPrefix(prefix: string, id: string): string {
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}
