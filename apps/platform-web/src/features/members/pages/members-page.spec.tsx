import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), isLiveApi: true }))
import { useAuth } from "@/features/auth/hooks/useAuth"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { MembersPage } from "./members-page"
import { WorkspaceSwitcher } from "@/layout/workspace-switcher"

let tenantRole = "member"
let roleA = "admin"
let invitationStatus = "delivery_failed"
let invitationUpdatedAt = new Date().toISOString()
let memberRole = "editor"
let invitationEtag = '"i1"'
const calls: Array<{ path: string; method: string; body: unknown; etag: string | null }> = []
const me = () => ({ userId: "admin", tenantId: "tenant", name: "Admin", email: "admin@acme.test", tenantRole, workspaceRoles: [{ workspaceId: "workspace-a", role: roleA }, { workspaceId: "workspace-b", role: "viewer" }] })
const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
  const path = String(url), method = init?.method ?? "GET"
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ path, method, body, etag: new Headers(init?.headers).get("if-match") })
  if (path.endsWith("/auth/me")) return Response.json(me())
  if (path === "/api/v1/workspaces") return Response.json([{ id: "workspace-a", name: "Alpha" }, { id: "workspace-b", name: "Beta" }, { id: "workspace-foreign", name: "Foreign" }])
  if (path.includes("/members/invitations?") && method === "GET") return Response.json([{ id: "invitation", workspaceId: "workspace-a", email: "pending@acme.test", role: "approver", status: invitationStatus, updatedAt: invitationUpdatedAt, expiresAt: "2030-01-01T00:00:00Z", etag: invitationEtag }])
  if (path === "/api/v1/members/invitations/invitation/resend") { invitationStatus = "pending"; invitationEtag = '"i2"'; return Response.json({}) }
  if (path === "/api/v1/members/invitations/invitation") { invitationStatus = "revoked"; return new Response(null, { status: 204 }) }
  if (path === "/api/v1/members" && method === "POST") return Response.json({ detail: "Invitation provider unavailable" }, { status: 503 })
  if (path === "/api/v1/members/editor" && method === "PATCH") { memberRole = (body as { role: string }).role; return Response.json({}) }
  if (path.includes("/members?")) return Response.json([
    { id: "owner", name: "Ada Owner", email: "owner@acme.test", role: "admin", tenantOwner: true, etag: '"owner1"' },
    { id: "editor", name: "Em Editor", email: "editor@acme.test", role: memberRole, tenantOwner: false, etag: '"member1"' },
  ])
  throw new Error(`Unexpected request ${method} ${path}`)
})
function Controls() {
  const { selectWorkspace, setMockRole } = usePermissions()
  return <><button onClick={() => selectWorkspace("workspace-a")}>Select A</button><button onClick={() => selectWorkspace("workspace-b")}>Select B</button><button onClick={() => setMockRole("owner")}>Mock owner</button></>
}
function renderPage(switcher = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={client}><Controls />{switcher && <WorkspaceSwitcher />}<MembersPage /></QueryClientProvider></MemoryRouter>)
}
beforeEach(() => {
  calls.length = 0; tenantRole = "member"; roleA = "admin"; invitationStatus = "delivery_failed"; memberRole = "editor"; invitationUpdatedAt = new Date().toISOString(); invitationEtag = '"i1"'
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear(); vi.stubGlobal("confirm", () => true)
  useAuth.setState({ user: me() as NonNullable<ReturnType<typeof useAuth.getState>["user"]>, isAuthenticated: true, validated: true })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAuth.setState({ user: null, isAuthenticated: false }) })
describe("live members UI", () => {
  it("uses selected workspace, separates immutable owner badge and exposes five fixed invite roles", async () => {
    renderPage(); await userEvent.click(screen.getByText("Select A"))
    expect(await screen.findByText("Tenant owner")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Actions for Ada Owner" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Invite member" }))
    const options = screen.getAllByRole("option")
    expect(options.map(option => (option as HTMLOptionElement).value)).toEqual(["admin", "editor", "operator", "approver", "viewer"])
    await userEvent.type(screen.getByLabelText("Email address"), "new@acme.test")
    await userEvent.selectOptions(screen.getByLabelText("Role"), "operator")
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }))
    expect(await screen.findByText("Invitation provider unavailable")).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(calls.find(call => call.method === "POST" && call.path === "/api/v1/members")?.body).toEqual({ workspaceId: "workspace-a", email: "new@acme.test", role: "operator" })
  })
  it("resends failed delivery and revokes current invitation with actual edit version", async () => {
    renderPage(); await userEvent.click(screen.getByText("Select A"))
    expect(await screen.findByText(/delivery failed/)).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Resend invitation" }))
    expect(await screen.findByText(/approver · pending/)).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Revoke invitation" }))
    expect(await screen.findByText(/approver · revoked/)).toBeTruthy()
    expect(calls.filter(call => call.method !== "GET").map(call => [call.method, call.etag])).toEqual([["POST", '"i1"'], ["DELETE", '"i2"']])
  })
  it.each([false, true])("allows a retry only for a stale delivering record (stale=%s)", async stale => {
    invitationStatus = "delivering"; invitationUpdatedAt = new Date(Date.now() - (stale ? 61000 : 0)).toISOString()
    renderPage(); await userEvent.click(screen.getByText("Select A"))
    expect(await screen.findByText(/approver · delivering/)).toBeTruthy()
    expect(!!screen.queryByRole("button", { name: "Resend invitation" })).toBe(stale)
  })
  it("updates role through real client with loaded ETag", async () => {
    renderPage(); await userEvent.click(screen.getByText("Select A"))
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Em Editor" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Make Operator" }))
    await waitFor(() => expect(calls.find(call => call.method === "PATCH")).toMatchObject({ path: "/api/v1/members/editor", etag: '"member1"', body: { role: "operator" } }))
    await waitFor(() => expect(screen.getByText("operator")).toBeTruthy())
  })
  it("uses actual selected workspace role; mock owner cannot grant live permissions", async () => {
    renderPage(true); await userEvent.click(screen.getByText("Select A"))
    expect(await screen.findByRole("button", { name: "Invite member" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: /Alpha/ }))
    expect(screen.queryByRole("menuitem", { name: "Foreign" })).toBeNull()
    await userEvent.click(await screen.findByRole("menuitem", { name: "Beta" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull())
    await userEvent.click(screen.getByText("Mock owner"))
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull()
    await waitFor(() => expect(calls.some(call => call.path === "/api/v1/members?workspaceId=workspace-b")).toBe(true))
    act(() => { roleA = "viewer"; useAuth.setState({ user: me() as NonNullable<ReturnType<typeof useAuth.getState>["user"]> }) })
    await userEvent.click(screen.getByText("Select A"))
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull()
  })
})
