import { describe, expect, it, vi } from "vitest";

import type { CostStoreProvider } from "../database/cost-store.token";
import { RunTotalService } from "./run-total.service";

const TENANT = "ten_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "ws_018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const RUN = "run_018f4d6e-cccc-7ccc-8ccc-cccccccccccc";

function setup(internal: string, marginRate: number) {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rowCount: 1, rows: [{ internal_cost_minor: internal, event_count: "3" }] }));
  const store = {
    withTenant: async (_tenant: string, operation: (tx: { query: typeof query }) => Promise<unknown>) => operation({ query }),
  } as unknown as CostStoreProvider;
  return { query, service: new RunTotalService(store, marginRate) };
}

describe("RunTotalService", () => {
  it("bills the run's total internal cost with the margin applied once, rounding up", async () => {
    const { service, query } = setup("1000", 0.2);
    await expect(service.getForRun({ tenantId: TENANT, workspaceId: WORKSPACE, runId: RUN })).resolves.toEqual({
      billableMinor: "1250",
      eventCount: "3",
    });
    expect(query.mock.calls[0]![1]).toEqual([
      "018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      "018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
      "018f4d6e-cccc-7ccc-8ccc-cccccccccccc",
    ]);
    // 3 paise at 20% margin is 3.75, billed as 4: rounded once, up.
    await expect(setup("3", 0.2).service.getForRun({ tenantId: TENANT, workspaceId: WORKSPACE, runId: RUN })).resolves.toMatchObject({ billableMinor: "4" });
  });

  it("a run with no cost events costs nothing", async () => {
    await expect(setup("0", 0.2).service.getForRun({ tenantId: TENANT, workspaceId: WORKSPACE, runId: RUN })).resolves.toMatchObject({ billableMinor: "0" });
  });

  it.each([
    [{ tenantId: undefined, workspaceId: WORKSPACE, runId: RUN }, "tenantId is required"],
    [{ tenantId: "x", workspaceId: WORKSPACE, runId: RUN }, "tenantId must have prefix ten_"],
    [{ tenantId: TENANT, workspaceId: "ws_nope", runId: RUN }, "workspaceId must be a ws_ prefixed UUID"],
    [{ tenantId: TENANT, workspaceId: WORKSPACE, runId: "run_1" }, "runId must be a run_ prefixed UUID"],
  ])("refuses a bad request before reading (%#)", async (input, message) => {
    const { service, query } = setup("1", 0.2);
    await expect(service.getForRun(input)).rejects.toThrow(message);
    expect(query).not.toHaveBeenCalled();
  });
});
