import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
const fixture = vi.hoisted(() => ({ live: true }))
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), get isLiveApi() { return fixture.live } }))
import { TenantDetail } from "./tenant-detail"
const id = "018f47a5-7b2c-7d10-8f11-123456789abc"
const window = { tenant_id: id, start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" }
const fetcher = vi.fn<typeof fetch>()
let roles = ["staff_support"], grant = true, unavailable = false
let activity: Record<string, unknown>
let waitActivity: Promise<void> | undefined
beforeEach(() => {
  fixture.live = true; roles = ["staff_support"]; grant = true; unavailable = false; waitActivity = undefined
  activity = { ...window, workflow_count: 51, run_count: 79,
    workflows: [{ id: `wf_${id}`, workspace_id: id, name: "Recorded support workflow", status: "active", updated_at: window.end_at }],
    runs: [{ id: `run_${id}`, workspace_id: id, workflow_id: `wf_${id}`, status: "failed", created_at: window.start_at }],
    members: { count: 63, members: [{ id, name: "Recorded member", email: "recorded@example.test", role: "owner" }] },
    spend: { ...window, currencies: [{ currency: "INR", billed_minor: "12345", event_count: 2 }, { currency: "USD", billed_minor: "900719925474099312", event_count: 1 }] },
  }
  fetcher.mockReset(); vi.stubGlobal("fetch", fetcher)
  fetcher.mockImplementation(async url => {
    const path = new URL(String(url), "http://app.test").pathname
    if (path.endsWith("/admin/session")) return Response.json({ staffUserId: "stf_actual", email: "staff@example.test", roles })
    if (path.endsWith("/staff-access/grants")) return Response.json({ data: grant ? [{ id: "jit_activity", tenant_id: id, scopes: ["tenant:read"], expires_at: new Date(Date.now() + 60_000).toISOString() }] : [] })
    if (path.endsWith("/actions")) return Response.json([])
    if (path.endsWith("/activity")) { await waitActivity; return unavailable ? Response.json({ detail: "Recorded activity unavailable" }, { status: 502 }) : Response.json(activity) }
    return Response.json({ id, name: "Actual tenant", status: "active", created_at: window.end_at, entitlement: { plan: "pro" } })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function view(value = id) {
  render(<MemoryRouter initialEntries={[`/tenants/${value}`]}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Routes><Route path="/tenants/:tenantId" element={<TenantDetail />} /></Routes></QueryClientProvider></MemoryRouter>)
}
describe("recorded tenant detail activity", () => {
  it("renders the served counts, bounded records, exact currencies and period through live HTTP", async () => {
    view(); const table = await screen.findByRole("table", { name: "Tenant workflows" })
    expect(within(table).getByText("Recorded support workflow")).toBeTruthy()
    expect(screen.getByLabelText("Member count").textContent).toBe("63")
    expect(screen.getByLabelText("Workflow count").textContent).toBe("51")
    expect(screen.getByLabelText("Thirty-day run count").textContent).toBe("79")
    expect(screen.getByText("Showing 1 of 63.")).toBeTruthy()
    expect(within(screen.getByRole("table", { name: "Tenant members" })).getByText("recorded@example.test")).toBeTruthy()
    expect(within(screen.getByRole("table", { name: "Tenant recent runs" })).getByText("failed")).toBeTruthy()
    expect(screen.getByText(/INR.*123\.45/)).toBeTruthy()
    expect(screen.getByText(/USD.*9,007,199,254,740,993\.12/)).toBeTruthy()
    expect(screen.getByText(/30-day period:/).textContent).toContain("Runs count their creation time")
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/activity"))!
    expect(call[1]?.credentials).toBe("include")
    expect(new Headers(call[1]?.headers).get("x-alter-support-grant")).toBe("jit_activity")
  })
  it("shows loading while an actual activity request remains pending", async () => {
    let release!: () => void; waitActivity = new Promise(resolve => { release = resolve })
    view(); expect((await screen.findByRole("status")).textContent).toBe("Loading tenant activity…")
    expect(screen.queryByLabelText("Member count")).toBeNull(); release()
    await screen.findByRole("table", { name: "Tenant workflows" })
  })
  it("shows actual empty records and no events without inventing spend", async () => {
    activity = { ...window, workflow_count: 0, run_count: 0, workflows: [], runs: [], members: { count: 0, members: [] }, spend: { ...window, currencies: [] } }
    view(); await screen.findByText("No cost events in this period.")
    expect(screen.getByText("No members.")).toBeTruthy(); expect(screen.getByText("No workflows.")).toBeTruthy(); expect(screen.getByText("No runs in this period.")).toBeTruthy()
    expect(screen.getByLabelText("Thirty-day run count").textContent).toBe("0")
  })
  it("keeps upstream failure explicit and reloads actual activity", async () => {
    unavailable = true; view(); expect((await screen.findByRole("alert")).textContent).toContain("Recorded activity unavailable")
    expect(screen.queryByLabelText("Thirty-day run count")).toBeNull(); expect(screen.queryByText("Demo support workflow")).toBeNull()
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Reload tenant activity" }))
    await screen.findByRole("table", { name: "Tenant workflows" }); expect(screen.queryByRole("alert")).toBeNull()
  })
  it("does not issue tenant reads when support has no current grant", async () => {
    grant = false; view(); await screen.findByText("Support access required")
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(`/tenants/${id}`))).toBe(false)
  })
  it("billing staff reads without claiming a support grant", async () => {
    roles = ["staff_billing_ops"]; view(); await screen.findByRole("table", { name: "Tenant workflows" })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("staff-access/grants"))).toBe(false)
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/activity"))!
    expect(new Headers(call[1]?.headers).has("x-alter-support-grant")).toBe(false)
  })
  it("rejects a mismatched or malformed live response without showing made-up records", async () => {
    activity.tenant_id = "018f47a5-7b2c-7d10-8f11-123456789abd"; activity.spend = { ...window, tenant_id: activity.tenant_id, currencies: [] }
    view(); await screen.findByRole("alert"); expect(screen.queryByRole("table", { name: "Tenant workflows" })).toBeNull()
    activity = { ...activity, tenant_id: id, spend: { ...window, currencies: [] }, internal_cost_minor: "12" }
    fireEvent.click(screen.getByRole("button", { name: "Reload tenant activity" }))
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/activity"))).toHaveLength(2))
    expect(screen.queryByText("Demo support workflow")).toBeNull()
  })
  it("serves explicit demo records without a live request", async () => {
    fixture.live = false; view("ten-1"); await screen.findByRole("table", { name: "Tenant workflows" })
    expect(screen.getByText("Demo support workflow")).toBeTruthy(); expect(screen.getByText(/INR.*123\.45/)).toBeTruthy(); expect(fetcher).not.toHaveBeenCalled()
  })
})
