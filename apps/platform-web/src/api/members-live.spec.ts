import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./http", async original => ({ ...await original<typeof import("./http")>(), isLiveApi: true }))
import { api } from "./client"
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })
afterEach(() => vi.unstubAllGlobals())
describe("live workspace membership client", () => {
  it("reads selected workspace and retains owner badge and edit version", async () => {
    fetchMock.mockResolvedValue(Response.json([{ id: "member-id", workspaceId: "workspace-b", email: "ada@acme.test", name: null, role: "editor", tenantOwner: true, etag: '"v1"' }]))
    expect(await api.getMembers("workspace-b")).toMatchObject([{ name: "ada@acme.test", role: "editor", tenantOwner: true, etag: '"v1"' }])
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/members?workspaceId=workspace-b")
  })
  it("sends selected workspace/email/fixed role and reads separate invitation lifecycle", async () => {
    const invitation = { id: "invite-id", workspaceId: "workspace-b", email: "ada@acme.test", role: "approver", status: "pending", etag: '"i1"' }
    fetchMock.mockResolvedValueOnce(Response.json(invitation)).mockResolvedValueOnce(Response.json([invitation]))
    expect(await api.inviteMember("workspace-b", "ada@acme.test", "approver")).toEqual(invitation)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ workspaceId: "workspace-b", email: "ada@acme.test", role: "approver" })
    expect(await api.getInvitations("workspace-b")).toEqual([invitation])
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/v1/members/invitations?workspaceId=workspace-b")
  })
  it("forwards current ETag for role update, workspace removal, resend and revoke", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }))
    await api.updateMemberRole("w", "m", "operator", '"m1"')
    await api.removeMember("w", "m", '"m2"')
    await api.resendInvite("w", "i", '"i1"')
    await api.revokeInvite("w", "i", '"i2"')
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, new Headers(init?.headers).get("if-match")])).toEqual([
      ["/api/v1/members/m", "PATCH", '"m1"'], ["/api/v1/members/m?scope=workspace", "DELETE", '"m2"'],
      ["/api/v1/members/invitations/i/resend", "POST", '"i1"'], ["/api/v1/members/invitations/i", "DELETE", '"i2"'],
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ role: "operator" })
  })
  it("propagates stale/delivery failures without reporting success", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ detail: "Invitation delivery unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ detail: "Membership changed" }, { status: 412 }))
    await expect(api.inviteMember("w", "ada@acme.test", "viewer")).rejects.toThrow("Invitation delivery unavailable")
    await expect(api.updateMemberRole("w", "m", "viewer", '"old"')).rejects.toThrow("Membership changed")
  })
  it("requests authenticated provider reset without submitting a password or email", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ requested: true })).mockResolvedValueOnce(Response.json({ detail: "Change your password with your sign-in provider" }, { status: 400 }))
    await api.requestPasswordReset()
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/auth/password-reset")
    expect(fetchMock.mock.calls[0]![1]?.body).toBeUndefined()
    await expect(api.requestPasswordReset()).rejects.toThrow("sign-in provider")
  })
})
