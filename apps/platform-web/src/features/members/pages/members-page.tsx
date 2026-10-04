import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, UserPlus } from "lucide-react"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { useAuth } from "@/features/auth/hooks/useAuth"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { RequirePermission } from "@/features/permissions/components/require-permission"
import { Button } from "@/components/ui/button"
import { InviteMemberDialog } from "../components/invite-member-dialog"
import { MemberActionMenu } from "../components/member-action-menu"
import { InvitationActions } from "../components/invitation-actions"

export function MembersPage() {
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const { workspaceId, can } = usePermissions()
  const client = useQueryClient()
  React.useEffect(() => { if (isLiveApi) void useAuth.getState().validate() }, [workspaceId])
  React.useEffect(() => setInviteOpen(false), [workspaceId])
  const members = useQuery({ queryKey: queryKeys.members.all(workspaceId), queryFn: () => api.getMembers(workspaceId), enabled: !!workspaceId })
  const invitations = useQuery({ queryKey: [...queryKeys.members.all(workspaceId), "invitations"], queryFn: () => api.getInvitations(workspaceId), enabled: !!workspaceId && can("member.invite"), refetchInterval: 30000 })
  const reload = () => {
    void client.invalidateQueries({ queryKey: queryKeys.members.all(workspaceId) })
    if (isLiveApi) void useAuth.getState().validate()
  }
  if (!workspaceId) return <p className="p-6">Select a workspace to view members.</p>
  return <RequirePermission permission="member.read"><div className="p-6 space-y-6">
    <div className="flex items-center justify-between gap-4">
      <div><h1 className="text-2xl font-bold">Members</h1><p className="text-text-secondary mt-1">Manage access to the selected workspace.</p></div>
      <div className="flex gap-2"><Button variant="outline" onClick={reload}>Reload members</Button>
        {can("member.invite") && <Button onClick={() => setInviteOpen(true)}><UserPlus className="mr-2 h-4 w-4" />Invite member</Button>}
      </div>
    </div>
    {members.error && <p role="alert" className="text-danger">{members.error.message}</p>}
    {members.isLoading ? <Loader2 aria-label="Loading members" className="animate-spin" /> : <div className="border border-border rounded-xl overflow-x-auto">
      <table className="w-full text-sm text-left"><thead><tr><th className="p-4">Member</th><th>Workspace role</th><th>Actions</th></tr></thead><tbody>
        {members.data?.map(member => <tr key={member.id} className="border-t border-border">
          <td className="p-4"><div className="font-medium">{member.name}</div><div className="text-text-secondary">{member.email}</div></td>
          <td className="capitalize">{member.role}{member.tenantOwner && <span className="ml-2 text-primary">Tenant owner</span>}</td>
          <td className="p-4 text-right"><MemberActionMenu member={member} workspaceId={workspaceId} /></td>
        </tr>)}
      </tbody></table>
      {members.data?.length === 0 && <p className="p-4">No members in this workspace.</p>}
    </div>}
    {can("member.invite") && <section className="space-y-3" aria-label="Workspace invitations">
      <h2 className="text-lg font-semibold">Invitations</h2>
      <p className="text-sm text-text-secondary">Invitations expire after seven days. Delivery failures remain visible until resent or revoked.</p>
      {invitations.error && <p role="alert" className="text-danger">{invitations.error.message}</p>}
      {invitations.isLoading && <p>Loading invitations…</p>}
      {invitations.data?.length === 0 && <p>No invitations.</p>}
      {invitations.data?.map(invitation => <div key={invitation.id} className="rounded-lg border border-border p-4 flex justify-between gap-4">
        <div><p>{invitation.email}</p><p className="text-sm capitalize">{invitation.role} · {invitation.status.replace(/_/g, " ")}</p>
          <p className="text-xs text-text-secondary">Expires {new Date(invitation.expiresAt).toLocaleString()}</p></div>
        <InvitationActions invitation={invitation} workspaceId={workspaceId} />
      </div>)}
    </section>}
    <InviteMemberDialog key={workspaceId} open={inviteOpen} onOpenChange={setInviteOpen} workspaceId={workspaceId} />
  </div></RequirePermission>
}
