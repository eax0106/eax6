import type { CompiledDag } from "@alterx/contracts";

import { WorkflowNotFoundError, type OrchestrationTenantStore } from "../runs/run-launcher.service";
import type { RunEstimatesLedger, WorstCaseRunCostEstimator } from "./worst-case-run-cost-estimator";

/** How many recent verified runs make a "usually" figure worth showing (D4). */
export const USUAL_COST_RUNS = 5;

export interface RunEstimate {
  readonly currency: "INR";
  /** The worst case, in paise: what the run reserves against its budgets. Always present. */
  readonly at_most_minor: number;
  /** The average of the last five verified runs, in paise. Null until five have cost data. */
  readonly usually_minor: number | null;
  readonly sample_runs: number;
  readonly model_calls: number;
  /** Model calls the ledger has no price for; the worst case is too low by their share. */
  readonly unpriced_calls: number;
}

export interface RunPreviewSource {
  previewRun(
    tenantId: string,
    workflowId: string,
    workflowVersionId?: string,
  ): Promise<{ readonly workspaceId: string; readonly compiledDag: CompiledDag }>;
}

/**
 * D4 (design log section 9): the figure shown before every run, "usually X
 * (last five runs), at most Y (worst case)", and only "at most Y" until five
 * verified runs of the workflow have cost data.
 */
export class RunEstimateService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly source: RunPreviewSource,
    private readonly estimator: WorstCaseRunCostEstimator,
    private readonly ledger: RunEstimatesLedger,
  ) {}

  async estimate(
    tenantIdInput: string,
    callerWorkspaceId: string,
    workflowId: string,
    workflowVersionId?: string,
  ): Promise<RunEstimate> {
    const bareTenantId = tenantIdInput.replace(/^ten_/, "");
    const preview = await this.source.previewRun(tenantIdInput, workflowId, workflowVersionId);
    // A workflow of another workspace is answered as missing, never estimated.
    if (preview.workspaceId.replace(/^ws_/, "") !== callerWorkspaceId.replace(/^ws_/, "")) {
      throw new WorkflowNotFoundError(workflowId);
    }
    const worst = await this.estimator.estimate({ tenantId: tenantIdInput, compiledDag: preview.compiledDag });

    const runIds = await this.store.withTenant(bareTenantId, async (tx) => {
      const result = await tx.query<{ readonly id: string }>(
        `SELECT r.id
           FROM run_outcomes o
           JOIN runs r ON r.tenant_id = o.tenant_id AND r.id = o.run_id
          WHERE o.tenant_id = $1 AND r.workflow_id = $2 AND o.verdict = 'completed_verified'
          ORDER BY o.decided_at DESC
          LIMIT $3`,
        [bareTenantId, workflowId, USUAL_COST_RUNS],
      );
      return result.rows.map((row) => row.id);
    });
    let usually: number | null = null;
    let sampleRuns = 0;
    if (runIds.length === USUAL_COST_RUNS) {
      const average = await this.ledger.runsAverage({
        tenantId: `ten_${bareTenantId}`,
        workspaceId: preview.workspaceId.startsWith("ws_") ? preview.workspaceId : `ws_${preview.workspaceId}`,
        runIds,
      });
      sampleRuns = average.runCount;
      if (average.runCount === USUAL_COST_RUNS) usually = average.averageBillableMinor;
    }
    return {
      currency: "INR",
      at_most_minor: worst.billableMinor,
      usually_minor: usually,
      sample_runs: sampleRuns,
      model_calls: worst.modelCalls,
      unpriced_calls: worst.unpricedCalls,
    };
  }
}
