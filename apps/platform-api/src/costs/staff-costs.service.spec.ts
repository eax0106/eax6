import { describe, expect, it, vi } from "vitest";
import type { EngineConfig, EngineM2mTokenProvider } from "../engine";
import { StaffCostsService } from "./staff-costs.service";

const TENANT = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKSPACE = "ws_018f47a5-7b2c-7d10-8f11-123456789abc";
const config = { costLedgerBaseUrl: "https://costs.test/" } as EngineConfig;
const m2m: EngineM2mTokenProvider = { getAccessToken: vi.fn(async () => "m2m-token") };
const window = { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-10-01T00:00:00.000Z" };

function ledgerAnswer(): Response {
  return new Response(
    JSON.stringify({
      rollups_json: JSON.stringify({
        start_at: window.startAt,
        end_at: window.endAt,
        currency: "INR",
        dimensions: [],
        groups: [{ dimensions: {}, internal_cost_minor: "100", retry_cost_minor: "10", recovery_cost_minor: "5", billable_minor: "143", margin_minor: "43", event_count: 2 }],
        totals: { internal_cost_minor: "100", billable_minor: "143", margin_minor: "43" },
      }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("StaffCostsService (D24)", () => {
  it("reads the named tenant workspace with the service credential and keeps the full breakdown", async () => {
    const fetchImpl = vi.fn(async () => ledgerAnswer());
    const service = new StaffCostsService(config, m2m, fetchImpl as unknown as typeof fetch);

    const summary = await service.summary(TENANT, { workspaceId: WORKSPACE, ...window });

    expect(summary.totals).toEqual({ internalCostMinor: "100", billableMinor: "143", marginMinor: "43" });
    expect(summary.groups[0]).toMatchObject({ retryCostMinor: "10", recoveryCostMinor: "5", marginMinor: "43" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://costs.test/costs/summary?tenantId=${TENANT}&workspaceId=${WORKSPACE}&startAt=2026-09-01T00%3A00%3A00.000Z&endAt=2026-10-01T00%3A00%3A00.000Z`,
    );
    expect(init.headers).toMatchObject({ Authorization: "Bearer m2m-token" });
  });

  it.each([
    ["a bad tenant", "ten_nope", { workspaceId: WORKSPACE, ...window }],
    ["no workspace", TENANT, window],
    ["an unordered window", TENANT, { workspaceId: WORKSPACE, startAt: window.endAt, endAt: window.startAt }],
  ])("refuses %s before calling the ledger", async (_name, tenant, query) => {
    const fetchImpl = vi.fn();
    const service = new StaffCostsService(config, m2m, fetchImpl as unknown as typeof fetch);
    await expect(service.summary(tenant, query)).rejects.toMatchObject({ response: { status: 400 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the ledger is down or answers nonsense", async () => {
    const down = new StaffCostsService(config, m2m, vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch);
    await expect(down.summary(TENANT, { workspaceId: WORKSPACE, ...window })).rejects.toMatchObject({ response: { status: 502 } });
    const nonsense = new StaffCostsService(
      config,
      m2m,
      vi.fn(async () => new Response(JSON.stringify({ rollups_json: "{}" }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(nonsense.summary(TENANT, { workspaceId: WORKSPACE, ...window })).rejects.toMatchObject({
      response: { status: 502, error_code: "INVALID_COST_ROLLUP_RESPONSE" },
    });
  });
});
