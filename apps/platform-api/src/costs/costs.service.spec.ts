import { describe, expect, it, vi } from "vitest";
import { CostLedgerClient, EngineClient } from "../engine";
import type { ActorContext } from "../rbac/types";
import { CostsService } from "./costs.service";

const actor: ActorContext = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  session_id: "session-a",
  roles: ["viewer"],
  permissions: ["billing:read"],
};

describe("CostsService", () => {
  it("reshapes all supported rollup dimensions into the billed-only tenant response (D24)", async () => {
    const client = {
      getSummary: vi.fn().mockResolvedValue(JSON.stringify({
        start_at: "2026-01-01T00:00:00.000Z",
        end_at: "2026-02-01T00:00:00.000Z",
        currency: "INR",
        dimensions: ["mode", "source", "provider", "resource"],
        groups: [{
          dimensions: {
            mode: "workflow",
            source: "model_gateway",
            provider: "bedrock",
            resource: "claude",
          },
          internal_cost_minor: "100",
          retry_cost_minor: "10",
          recovery_cost_minor: "5",
          billable_minor: "143",
          margin_minor: "43",
          event_count: 2,
        }],
        totals: { internal_cost_minor: "100", billable_minor: "143", margin_minor: "43" },
      })),
    } as unknown as CostLedgerClient;
    const service = new CostsService(client, {} as EngineClient);

    await expect(service.summary({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-02-01T00:00:00.000Z",
      currency: "INR",
      dimensions: ["mode", "source", "provider", "resource"],
    }, actor, undefined)).resolves.toEqual({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-02-01T00:00:00.000Z",
      currency: "INR",
      dimensions: ["mode", "source", "provider", "resource"],
      groups: [{
        dimensions: { mode: "workflow", source: "model_gateway", provider: "bedrock", resource: "claude" },
        billableMinor: "143",
        eventCount: 2,
      }],
      totals: { billableMinor: "143" },
    });
  });

  it("accepts real empty state and rejects malformed upstream rollups", async () => {
    const client = {
      getSummary: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          start_at: "2026-01-01T00:00:00.000Z",
          end_at: "2026-02-01T00:00:00.000Z",
          currency: "INR",
          dimensions: [], groups: [],
          totals: { internal_cost_minor: "0", billable_minor: "0", margin_minor: "0" },
        }))
        .mockResolvedValueOnce("not-json"),
    } as unknown as CostLedgerClient;
    const service = new CostsService(client, {} as EngineClient);
    const query = { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-02-01T00:00:00.000Z" };

    await expect(service.summary(query, actor, undefined)).resolves.toMatchObject({ groups: [] });
    await expect(service.summary(query, actor, undefined)).rejects.toMatchObject({
      response: { status: 502, error_code: "INVALID_COST_ROLLUP_RESPONSE" },
    });
  });
});

/** D24: no tenant response may carry Alter's internal cost or its margin. */
export function internalCostKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => internalCostKeys(entry, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(/internal|margin|retry_?cost|recovery_?cost/i.test(key) ? [`${path}.${key}`] : []),
    ...internalCostKeys(entry, `${path}.${key}`),
  ]);
}

describe("CostsService tenant responses (D24)", () => {
  const rollup = JSON.stringify({
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2026-02-01T00:00:00.000Z",
    currency: "INR",
    dimensions: ["provider"],
    groups: [{
      dimensions: { provider: "bedrock" },
      internal_cost_minor: "100", retry_cost_minor: "10", recovery_cost_minor: "5",
      billable_minor: "143", margin_minor: "43", event_count: 2,
    }],
    totals: { internal_cost_minor: "100", billable_minor: "143", margin_minor: "43" },
  });

  it("the summary carries no internal cost, retry or recovery cost, or margin", async () => {
    const service = new CostsService({ getSummary: vi.fn().mockResolvedValue(rollup) } as unknown as CostLedgerClient, {} as EngineClient);
    const summary = await service.summary(
      { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-02-01T00:00:00.000Z", dimensions: "provider" },
      actor,
      undefined,
    );
    expect(internalCostKeys(summary)).toEqual([]);
    expect(summary.totals.billableMinor).toBe("143");
  });

  it("the scan itself catches an internal field (positive control)", () => {
    expect(internalCostKeys({ totals: { billableMinor: "1", marginMinor: "1" } })).toEqual(["$.totals.marginMinor"]);
    expect(internalCostKeys([{ internal_cost_minor: "1" }])).toEqual(["$[0].internal_cost_minor"]);
  });
});

describe("CostsService.workflowCost (D24)", () => {
  const WORKFLOW = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
  const OTHER_WS = "ws_018f47a5-7b2c-7d10-8f11-123456789abd";
  const run = (n: number, createdAt: string, workspace: string | null = actor.workspace_id ?? null) => ({
    id: `run_018f47a5-7b2c-7d10-8f11-${n.toString(16).padStart(12, "0")}`,
    workflow_id: WORKFLOW,
    workspace_id: workspace,
    created_at: createdAt,
  });

  function setup(pages: { data: unknown[]; next: string | null }[], totals: Record<string, string>) {
    let call = 0;
    const get = vi.fn(async () => {
      const page = pages[call] ?? { data: [], next: null };
      call += 1;
      return { status: 200, body: { data: page.data, page: { next_cursor: page.next, has_more: page.next !== null, limit: 200 } } };
    });
    const getRunTotals = vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, totals[id] ?? "0"])));
    const service = new CostsService({ getRunTotals } as unknown as CostLedgerClient, { get } as unknown as EngineClient);
    return { service, get, getRunTotals };
  }

  const window = { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-10-01T00:00:00.000Z" };

  it("sums the billed cost of the workflow's runs in the window and in the caller's workspace only", async () => {
    const inside = run(1, "2026-09-20T00:00:00.000Z");
    const later = run(2, "2026-10-02T00:00:00.000Z");
    const otherWorkspace = run(3, "2026-09-15T00:00:00.000Z", OTHER_WS);
    const inside2 = run(4, "2026-09-10T00:00:00.000Z");
    const before = run(5, "2026-08-31T23:59:59.000Z");
    const { service, get, getRunTotals } = setup(
      [{ data: [later, inside, otherWorkspace], next: "cursor-1" }, { data: [inside2, before], next: "cursor-2" }],
      { [inside.id]: "120", [inside2.id]: "30", [otherWorkspace.id]: "999" },
    );

    const cost = await service.workflowCost(WORKFLOW, window, actor, undefined);

    expect(cost).toEqual({ workflowId: WORKFLOW, ...window, currency: "INR", billableMinor: "150", runCount: 2 });
    expect(getRunTotals).toHaveBeenCalledWith([inside.id, inside2.id], expect.objectContaining({ workspaceId: actor.workspace_id }), `/api/v1/workflows/${WORKFLOW}/costs`);
    // The second page reached a run older than the window, so no third page is read.
    expect(get).toHaveBeenCalledTimes(2);
    expect(String((get.mock.calls[0] as unknown[])[0])).toBe(`/api/v1/runs?workflow_id=${WORKFLOW}&limit=200`);
    expect(String((get.mock.calls[1] as unknown[])[0])).toContain("cursor=cursor-1");
    expect(internalCostKeys(cost)).toEqual([]);
  });

  it("costs nothing, without asking the ledger, when no run falls in the window", async () => {
    const { service, getRunTotals } = setup([{ data: [], next: null }], {});
    await expect(service.workflowCost(WORKFLOW, window, actor, undefined)).resolves.toMatchObject({ billableMinor: "0", runCount: 0 });
    expect(getRunTotals).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad workflow id", "wf_nope", window],
    ["an unordered window", WORKFLOW, { startAt: window.endAt, endAt: window.startAt }],
    ["a window over 93 days", WORKFLOW, { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-06-01T00:00:00.000Z" }],
    ["an unknown field", WORKFLOW, { ...window, tenantId: "ten_x" }],
  ])("refuses %s before reading anything", async (_name, workflowId, query) => {
    const { service, get } = setup([], {});
    await expect(service.workflowCost(workflowId, query, actor, undefined)).rejects.toMatchObject({ response: { status: 400 } });
    expect(get).not.toHaveBeenCalled();
  });
});
