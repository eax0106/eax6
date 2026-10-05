import { describe, expect, it, vi } from "vitest";
import { TenantActivityClient } from "./tenant-activity-client";
import { engineConfigFromEnvironment } from "./config";
import { EngineProblemError } from "./problem";
const window = { tenant_id: "018f47a5-7b2c-7d10-8f11-123456789abc", start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" };
const activity = { ...window, workflow_count: 0, run_count: 0, workflows: [], runs: [] };
const spend = { ...window, currencies: [{ currency: "INR", billed_minor: "9007199254740993", event_count: 1 }] };
const config = engineConfigFromEnvironment({ ENGINE_BASE_URL: "http://engine.test/", ADS_CORE_BASE_URL: "http://ads.test", COST_LEDGER_BASE_URL: "http://cost.test/", EVAL_FACADE_TOKEN_REF: "fixture", DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "fixture", AUDIT_SERVICE_BASE_URL: "http://audit.test", AUDIT_QUERY_SERVICE_TOKEN_REF: "fixture", ENGINE_M2M_TOKEN_URL: "http://issuer.test", ENGINE_M2M_AUDIENCE: "engine", ENGINE_M2M_CLIENT_ID: "platform", ENGINE_M2M_CLIENT_SECRET_REF: "fixture" });
describe("tenant activity service transport", () => {
  it.each(["activity", "spend"] as const)("sends authenticated bounded %s request and validates the response", async kind => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(kind === "activity" ? activity : spend));
    const result = await new TenantActivityClient(config, { getAccessToken: async () => "test-machine-token" }, fetcher)[kind](window);
    expect(result).toEqual(kind === "activity" ? activity : spend);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(kind === "activity" ? "http://engine.test/internal/tenant-activity?" : "http://cost.test/internal/tenant-spend?");
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual(window);
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer test-machine-token");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["activity", "spend"] as const)("fails closed when %s transport, token, scope or schema fails", async kind => {
    for (const value of [{ ...window, tenant_id: "018f47a5-7b2c-7d10-8f11-123456789abd" }, { ...window, start_at: "2026-09-04T00:00:00.000Z", end_at: "2026-10-04T00:00:00.000Z" }, { internal_cost_minor: "1" }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...(kind === "activity" ? activity : spend), ...value }));
      await expect(new TenantActivityClient(config, { getAccessToken: async () => "test-token" }, fetcher)[kind](window)).rejects.toBeInstanceOf(EngineProblemError);
    }
    for (const fetcher of [vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 })), vi.fn<typeof fetch>().mockRejectedValue(new Error("Connection refused")), vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid JSON"))]) {
      await expect(new TenantActivityClient(config, { getAccessToken: async () => "test-token" }, fetcher)[kind](window)).rejects.toMatchObject({ problem: { status: 502 } });
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new TenantActivityClient(config, { getAccessToken: async () => { throw new Error("Issuer unavailable"); } }, fetcher)[kind](window)).rejects.toBeInstanceOf(EngineProblemError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
