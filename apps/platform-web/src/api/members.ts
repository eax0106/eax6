import { apiDelete, apiGet, apiPatch, apiPost, isLiveApi, mutationKey } from "./http"
import { mockMembers, delay } from "./mock/data"
import { WORKSPACE_ROLES, type Member, type WorkspaceInvitation, type WorkspaceRole } from "./types"

const path = "/api/v1/members"
const members = new Map<string, Member[]>()
const invitations: WorkspaceInvitation[] = []
const copy = <T>(value: T): T => structuredClone(value)
const workspaceMembers = (workspaceId: string) => {
  if (!members.has(workspaceId)) members.set(workspaceId, mockMembers.filter(member => member.status === "active").map(member => ({
    ...member, id: `${workspaceId}-${member.id}`, workspaceId, userId: member.id, etag: `"${workspaceId}-${member.id}-1"`,
  })))
  return members.get(workspaceId)!
}
function requireRole(role: WorkspaceRole) {
  if (!WORKSPACE_ROLES.includes(role)) throw new Error("One fixed workspace role required")
}
function match(actual: string | undefined, supplied: string | undefined) {
  if (!supplied) throw new Error("Reload members before changing this record")
  if (actual !== supplied) throw new Error("Record changed. Reload members and try again.")
}
function advance(record: { etag?: string }) { record.etag = `"${crypto.randomUUID()}"` }

export async function getMembers(workspaceId: string): Promise<Member[]> {
  if (!workspaceId) throw new Error("Select a workspace")
  if (isLiveApi) {
    const records = await apiGet<Array<Member & { name: string | null }>>(`${path}?workspaceId=${encodeURIComponent(workspaceId)}`)
    return records.map(record => ({ ...record, name: record.name || record.email, status: "active", joinedAt: "" }))
  }
  await delay(100)
  return copy(workspaceMembers(workspaceId))
}
export async function getInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  if (!workspaceId) throw new Error("Select a workspace")
  if (isLiveApi) return apiGet(`${path}/invitations?workspaceId=${encodeURIComponent(workspaceId)}`)
  await delay(100)
  return copy(invitations.filter(invitation => invitation.workspaceId === workspaceId).map(invitation => ({ ...invitation,
    status: invitation.status === "pending" && Date.parse(invitation.expiresAt) <= Date.now() ? "expired" : invitation.status,
  })))
}
export async function inviteMember(workspaceId: string, email: string, role: WorkspaceRole): Promise<WorkspaceInvitation> {
  requireRole(role)
  if (!workspaceId) throw new Error("Select a workspace")
  if (isLiveApi) return apiPost(path, { workspaceId, email, role }, { idempotencyKey: mutationKey("member-invite") })
  await delay(100)
  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) throw new Error("Valid email required")
  if (workspaceMembers(workspaceId).some(member => member.email.toLowerCase() === normalized) || invitations.some(invitation => invitation.workspaceId === workspaceId && invitation.email === normalized && ["pending", "delivering"].includes(invitation.status) && Date.parse(invitation.expiresAt) > Date.now())) throw new Error("Member or pending invitation already exists")
  const now = Date.now()
  const timestamp = new Date(now).toISOString()
  const invitation: WorkspaceInvitation = { id: crypto.randomUUID(), workspaceId, email: normalized, role, status: "pending",
    createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(now + 7 * 86400000).toISOString(), etag: `"${crypto.randomUUID()}"` }
  invitations.unshift(invitation)
  return copy(invitation)
}
export async function updateMemberRole(workspaceId: string, memberId: string, role: WorkspaceRole, etag?: string): Promise<void> {
  requireRole(role)
  if (isLiveApi) { await apiPatch(`${path}/${encodeURIComponent(memberId)}`, { role }, { ifMatch: etag }); return }
  await delay(100)
  const member = mutableMember(workspaceId, memberId, etag)
  if (member.role === "admin" && role !== "admin") otherAdmin(workspaceId, memberId)
  member.role = role; advance(member)
}
export async function removeMember(workspaceId: string, memberId: string, etag?: string): Promise<void> {
  if (isLiveApi) { await apiDelete(`${path}/${encodeURIComponent(memberId)}?scope=workspace`, { ifMatch: etag }); return }
  await delay(100)
  const member = mutableMember(workspaceId, memberId, etag)
  if (member.role === "admin") otherAdmin(workspaceId, memberId)
  members.set(workspaceId, workspaceMembers(workspaceId).filter(item => item.id !== memberId))
}
function mutableMember(workspaceId: string, memberId: string, etag?: string) {
  const member = workspaceMembers(workspaceId).find(item => item.id === memberId)
  if (!member) throw new Error("Member not found")
  if (member.tenantOwner) throw new Error("Tenant owner's membership cannot be changed")
  match(member.etag, etag); return member
}
function otherAdmin(workspaceId: string, memberId: string) {
  if (!workspaceMembers(workspaceId).some(item => item.id !== memberId && item.role === "admin")) throw new Error("Workspace must retain an admin")
}
export async function resendInvite(workspaceId: string, invitationId: string, etag?: string): Promise<void> {
  if (isLiveApi) { await apiPost(`${path}/invitations/${encodeURIComponent(invitationId)}/resend`, {}, { ifMatch: etag }); return }
  await delay(100)
  const invitation = mutableInvitation(workspaceId, invitationId, etag)
  if (["revoked", "accepted", "delivering"].includes(invitation.status)) throw new Error("Invitation cannot be resent in its current state")
  const now = Date.now()
  invitation.status = "pending"; invitation.expiresAt = new Date(now + 7 * 86400000).toISOString(); invitation.updatedAt = new Date(now).toISOString(); advance(invitation)
}
export async function revokeInvite(workspaceId: string, invitationId: string, etag?: string): Promise<void> {
  if (isLiveApi) { await apiDelete(`${path}/invitations/${encodeURIComponent(invitationId)}`, { ifMatch: etag }); return }
  await delay(100)
  const invitation = mutableInvitation(workspaceId, invitationId, etag)
  if (invitation.status === "accepted") throw new Error("Remove the accepted membership instead")
  invitation.status = "revoked"; invitation.updatedAt = new Date().toISOString(); advance(invitation)
}
function mutableInvitation(workspaceId: string, invitationId: string, etag?: string) {
  const invitation = invitations.find(item => item.workspaceId === workspaceId && item.id === invitationId)
  if (!invitation) throw new Error("Invitation not found")
  match(invitation.etag, etag); return invitation
}
export async function requestPasswordReset(): Promise<void> {
  if (isLiveApi) { await apiPost("/api/v1/auth/password-reset"); return }
  await delay(100)
}
