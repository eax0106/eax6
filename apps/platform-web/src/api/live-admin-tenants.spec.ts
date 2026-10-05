import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))
vi.mock("./staff-auth", () => ({
  getStaffSession: vi.fn(async () => ({ staffUserId: "stf_1", email: "ops@alter.example", roles: ["staff_admin"] })),
}))

import { activeTenantGrant, getTenant, getTenantActivity, listTenants, requestTenantAccess } from "./live-admin-tenants"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc"

describe("live admin tenants", () => {
  it("validates live activity and carries cookie and support grant", async () => {
    const window = { tenant_id: tenantId, start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" }
    const body = { ...window, workflow_count: 0, run_count: 0, workflows: [], runs: [], members: { count: 0, members: [] }, spend: { ...window, currencies: [] } }
    fetchMock.mockResolvedValue(Response.json(body))
    expect(await getTenantActivity(tenantId, "jit_active")).toEqual(body)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain(`/tenants/${tenantId}/activity`); expect(init!.credentials).toBe("include")
    expect(new Headers(init!.headers).get("x-alter-support-grant")).toBe("jit_active")
    fetchMock.mockResolvedValue(Response.json({ ...body, internal_cost_minor: "123" }))
    await expect(getTenantActivity(tenantId)).rejects.toThrow()
    const other = { ...window, tenant_id: "018f47a5-7b2c-7d10-8f11-123456789abd" }
    fetchMock.mockResolvedValue(Response.json({ ...body, ...other, spend: { ...other, currencies: [] } }))
    await expect(getTenantActivity(tenantId)).rejects.toThrow("Tenant activity response does not match this tenant")
    fetchMock.mockResolvedValue(Response.json({ detail: "Activity unavailable" }, { status: 502 }))
    await expect(getTenantActivity(tenantId)).rejects.toThrow("Activity unavailable")
  })
  it("maps only the fields the API serves", async () => {
    fetchMock.mockResolvedValue(
      Response.json([{ id: tenantId, name: "Acme", status: "active", region: "ap-south-1", created_at: "2026-09-28T00:00:00Z" }]),
    )
    const [tenant] = await listTenants()
    expect(tenant).toEqual({
      id: tenantId,
      name: "Acme",
      status: "active",
      plan: undefined,
      region: "ap-south-1",
      createdAt: "2026-09-28T00:00:00Z",
    })
    expect(tenant!.memberCount).toBeUndefined()
  })

  it("sends the support grant on a detail read", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ id: tenantId, name: "Acme", status: "active", region: "ap-south-1", created_at: "x", entitlement: { plan: "pro" } }),
    )
    const tenant = await getTenant(tenantId, "jit_abc")
    expect(tenant.plan).toBe("pro")
    const [, init] = fetchMock.mock.calls[0]!
    expect(new Headers(init!.headers).get("x-alter-support-grant")).toBe("jit_abc")
  })

  it("picks only an active, unrevoked tenant:read grant for this tenant", async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const past = new Date(Date.now() - 60_000).toISOString()
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { id: "jit_expired", tenant_id: tenantId, expires_at: past, revoked_at: null, scopes: ["tenant:read"] },
          { id: "jit_revoked", tenant_id: tenantId, expires_at: future, revoked_at: past, scopes: ["tenant:read"] },
          { id: "jit_other", tenant_id: "other", expires_at: future, revoked_at: null, scopes: ["tenant:read"] },
          { id: "jit_audit", tenant_id: tenantId, expires_at: future, revoked_at: null, scopes: ["audit:read"] },
          { id: "jit_good", tenant_id: tenantId, expires_at: future, revoked_at: null, scopes: ["tenant:read"] },
        ],
      }),
    )
    expect((await activeTenantGrant(tenantId))?.id).toBe("jit_good")
  })

  it("grants the signed-in staff admin time-boxed tenant:read access with the reason", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "jit_new", expires_at: "2026-09-28T01:00:00Z" }))
    const grant = await requestTenantAccess(tenantId, "Investigate ticket 42", 60)
    expect(grant.id).toBe("jit_new")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/admin/staff-access/grants")
    expect(JSON.parse(String(init!.body))).toEqual({
      staff_user_id: "stf_1",
      tenant_id: tenantId,
      reason_code: "support_investigation",
      reason_text: "Investigate ticket 42",
      duration_minutes: 60,
      scopes: ["tenant:read"],
    })
  })
})
