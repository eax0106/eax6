import { describe, expect, it, vi } from "vitest";

import type { CompiledDag } from "@alterx/contracts";

import { HttpRunCostReader } from "./http-run-cost-reader";
import { RunBudgetGate } from "./run-budget-gate";
import type { EngineBudgetService } from "./budget.service";
import type { OrchestrationTransactionLike } from "../runs/run-launcher.service";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-000000000001";
const DAG = { nodes: [], edges: [] } as unknown as CompiledDag;

describe("RunBudgetGate", () => {
  it("reserves the estimated worst case for the run", async () => {
    const reserve = vi.fn(async () => []);
    const gate = new RunBudgetGate({ reserve } as unknown as EngineBudgetService, { billableMinor: async () => 0 }, { estimateMinor: async () => 750 });
    const tx = {} as OrchestrationTransactionLike;
    await gate.reserve(tx, { tenantId: TENANT, workspaceId: WORKSPACE, workflowId: "wf_1", runId: RUN, compiledDag: DAG });
    expect(reserve).toHaveBeenCalledWith(tx, { tenantId: TENANT, workspaceId: WORKSPACE, workflowId: "wf_1", runId: RUN, amountMinor: 750 });
  });

  it("settles to what the Cost Ledger says the run cost, asking with prefixed ids", async () => {
    const settle = vi.fn(async () => 1);
    const billableMinor = vi.fn(async () => 321);
    const gate = new RunBudgetGate({ settle } as unknown as EngineBudgetService, { billableMinor });
    await gate.settle({ tenantId: TENANT, workspaceId: WORKSPACE, runId: RUN });
    expect(billableMinor).toHaveBeenCalledWith({ tenantId: `ten_${TENANT}`, workspaceId: `ws_${WORKSPACE}`, runId: RUN });
    expect(settle).toHaveBeenCalledWith(TENANT, RUN, 321);
  });

  it("does not settle when the cost cannot be read, so the reservation stays for a later try", async () => {
    const settle = vi.fn();
    const gate = new RunBudgetGate({ settle } as unknown as EngineBudgetService, { billableMinor: async () => { throw new Error("ledger down"); } });
    await expect(gate.settle({ tenantId: TENANT, workspaceId: WORKSPACE, runId: RUN })).rejects.toThrow("ledger down");
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("HttpRunCostReader", () => {
  const tokens = { getAccessToken: async () => "tok" };

  it("reads the billed total from the run-total route with the service token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ billable_minor: "1250", event_count: "3" })));
    const reader = new HttpRunCostReader("http://costs.test/", tokens, fetchImpl as unknown as typeof fetch);
    await expect(reader.billableMinor({ tenantId: `ten_${TENANT}`, workspaceId: `ws_${WORKSPACE}`, runId: RUN })).resolves.toBe(1250);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(`http://costs.test/costs/run-total/${RUN}?tenantId=ten_${TENANT}&workspaceId=ws_${WORKSPACE}`);
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it.each([
    [new Response("no", { status: 500 }), "answered 500"],
    [new Response(JSON.stringify({ billable_minor: "-1" })), "not a whole amount"],
    [new Response(JSON.stringify({})), "not a whole amount"],
  ])("fails loudly instead of guessing a cost (%#)", async (response, message) => {
    const reader = new HttpRunCostReader("http://costs.test", tokens, (async () => response) as unknown as typeof fetch);
    await expect(reader.billableMinor({ tenantId: `ten_${TENANT}`, workspaceId: `ws_${WORKSPACE}`, runId: RUN })).rejects.toThrow(message);
  });
});
