import type { CompiledDag } from "@alterx/contracts";
import { describe, expect, it, vi } from "vitest";

import { WorkflowNotFoundError } from "../runs/run-launcher.service";
import { RunEstimateService } from "./run-estimate.service";
import type { RunEstimatesLedger, WorstCaseRunCostEstimator } from "./worst-case-run-cost-estimator";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const DAG = { nodes: [] } as unknown as CompiledDag;

function setup(runIds: string[], average: { averageBillableMinor: number | null; runCount: number }) {
  const query = vi.fn(async () => ({ rowCount: runIds.length, rows: runIds.map((id) => ({ id })) }));
  const store = { withTenant: async (_tenant: string, operation: (tx: { query: typeof query }) => Promise<unknown>) => operation({ query }) };
  const source = { previewRun: vi.fn(async () => ({ workspaceId: WORKSPACE, compiledDag: DAG })) };
  const estimator = { estimate: vi.fn(async () => ({ billableMinor: 900, modelCalls: 3, unpricedCalls: 1 })) } as unknown as WorstCaseRunCostEstimator;
  const runsAverage = vi.fn(async () => average);
  const ledger = { worstCase: vi.fn(), runsAverage } as unknown as RunEstimatesLedger;
  return { service: new RunEstimateService(store as never, source, estimator, ledger), query, runsAverage, source };
}

describe("RunEstimateService", () => {
  it("shows only the worst case until five verified runs exist", async () => {
    const { service, runsAverage } = setup(["run_1", "run_2"], { averageBillableMinor: 50, runCount: 2 });
    await expect(service.estimate(`ten_${TENANT}`, `ws_${WORKSPACE}`, "wf_1")).resolves.toEqual({
      currency: "INR",
      at_most_minor: 900,
      usually_minor: null,
      sample_runs: 0,
      model_calls: 3,
      unpriced_calls: 1,
    });
    expect(runsAverage).not.toHaveBeenCalled();
  });

  it("adds the average of the last five verified runs once five have cost data", async () => {
    const ids = ["run_1", "run_2", "run_3", "run_4", "run_5"];
    const { service, runsAverage, query } = setup(ids, { averageBillableMinor: 420, runCount: 5 });
    const result = await service.estimate(`ten_${TENANT}`, `ws_${WORKSPACE}`, "wf_1");
    expect(result).toMatchObject({ at_most_minor: 900, usually_minor: 420, sample_runs: 5 });
    expect(runsAverage).toHaveBeenCalledWith({ tenantId: `ten_${TENANT}`, workspaceId: `ws_${WORKSPACE}`, runIds: ids });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("o.verdict = 'completed_verified'"), [TENANT, "wf_1", 5]]);
  });

  it("holds the average back when a recent run has no cost data (fewer than five counted)", async () => {
    const { service } = setup(["run_1", "run_2", "run_3", "run_4", "run_5"], { averageBillableMinor: 400, runCount: 4 });
    await expect(service.estimate(`ten_${TENANT}`, `ws_${WORKSPACE}`, "wf_1")).resolves.toMatchObject({ usually_minor: null, sample_runs: 4 });
  });

  it("answers a workflow of another workspace as not found, without estimating it", async () => {
    const { service, query } = setup([], { averageBillableMinor: null, runCount: 0 });
    await expect(
      service.estimate(`ten_${TENANT}`, "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f2", "wf_1"),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(query).not.toHaveBeenCalled();
  });
});
