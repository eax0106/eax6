import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { listPolicies, listProviders, updateFeatureFlag } from "./live-admin-controls"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("live admin controls", () => {
  it("shows an inactive provider as disabled and an unhealthy one as an outage", async () => {
    const base = { interface_name: "ModelProvider", checked_at: "2026-09-28T00:00:00Z", latency_ms: 40, configuration_revision: "r1", fallback_chain: [] }
    fetchMock.mockResolvedValue(
      Response.json([
        { ...base, provider_id: "bedrock", health: "healthy", active: true },
        { ...base, provider_id: "openai", health: "healthy", active: false },
        { ...base, provider_id: "anthropic", health: "unhealthy", active: true },
      ]),
    )
    expect((await listProviders()).map((p) => [p.id, p.status, p.type])).toEqual([
      ["bedrock", "healthy", "model"],
      ["openai", "disabled", "model"],
      ["anthropic", "outage", "model"],
    ])
  })

  it("toggles a flag keeping its description and sending a reason", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ name: "hindi", enabled: true, description: "Hindi UI", revision: 2, updated_at: "x", updated_by: "stf_1" }),
    )
    await updateFeatureFlag(
      { id: "hindi", key: "hindi", name: "hindi", description: "Hindi UI", enabled: false, scope: "global", updatedAt: "x", updatedBy: { id: "stf_1", name: "stf_1" } },
      true,
    )
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/admin/policy/feature-flags/hindi")
    expect(JSON.parse(String(init!.body))).toEqual({ enabled: true, description: "Hindi UI", reason: "Changed in the admin console" })
  })

  it("lists plan limits and model alias bindings as the platform's policies", async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes("/policy/plans")
        ? Response.json([{ plan: "pro", limits: { runs_per_month: 1000 }, updated_at: "2026-09-28T00:00:00Z", updated_by: "stf_1" }])
        : Response.json({ version: "3", bindings: { FAST: { model_id: "apac.amazon.nova-micro-v1:0" } } }),
    )
    const policies = await listPolicies()
    expect(policies.map((p) => [p.id, p.category])).toEqual([
      ["plan:pro", "billing"],
      ["model:FAST", "execution"],
    ])
    expect(policies[1]!.updatedAt).toBeUndefined()
  })
})
