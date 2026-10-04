import { describe, expect, it } from "vitest"
import { api } from "./client"
describe("mock invitation lifecycle", () => {
  it("persists invitations only in selected workspace and changes versions on resend/revoke", async () => {
    const workspace = "mock-invitation-lifecycle"
    const invitation = await api.inviteMember(workspace, "Invitee@Acme.test", "approver")
    expect(invitation.email).toBe("invitee@acme.test")
    expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(7 * 86400000)
    expect(await api.getInvitations("another-workspace")).toEqual([])
    await expect(api.inviteMember(workspace, invitation.email, "viewer")).rejects.toThrow("already exists")
    await api.resendInvite(workspace, invitation.id, invitation.etag)
    const [resent] = await api.getInvitations(workspace)
    expect(resent!.etag).not.toBe(invitation.etag)
    await expect(api.revokeInvite(workspace, invitation.id, invitation.etag)).rejects.toThrow("Record changed")
    await api.revokeInvite(workspace, invitation.id, resent!.etag)
    const [revoked] = await api.getInvitations(workspace)
    expect(revoked!.status).toBe("revoked")
    await expect(api.resendInvite(workspace, invitation.id, revoked!.etag)).rejects.toThrow("cannot be resent")
  })
  it("persists fixed roles/removal and protects owner without changing another workspace", async () => {
    const workspace = "mock-role-lifecycle"
    const current = await api.getMembers(workspace)
    const owner = current.find(item => item.tenantOwner)!
    const editor = current.find(item => item.role === "editor")!
    await expect(api.removeMember(workspace, owner.id, owner.etag)).rejects.toThrow("owner")
    await api.updateMemberRole(workspace, editor.id, "operator", editor.etag)
    const changed = (await api.getMembers(workspace)).find(item => item.id === editor.id)!
    expect(changed.role).toBe("operator")
    await expect(api.removeMember(workspace, editor.id, editor.etag)).rejects.toThrow("Record changed")
    await api.removeMember(workspace, editor.id, changed.etag)
    expect((await api.getMembers(workspace)).some(item => item.id === editor.id)).toBe(false)
    expect((await api.getMembers("other-role-workspace")).some(item => item.role === "editor")).toBe(true)
  })
})
