import { useMutation, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { WORKSPACE_ROLES, type Member, type WorkspaceRole } from "@/api/types"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { useAuth } from "@/features/auth/hooks/useAuth"
import { isLiveApi } from "@/api/http"

export function MemberActionMenu({ member, workspaceId }: { member: Member; workspaceId: string }) {
  const { can } = usePermissions()
  const queryClient = useQueryClient()
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.members.all(workspaceId) })
    if (isLiveApi) void useAuth.getState().validate()
  }
  const remove = useMutation({ mutationFn: () => api.removeMember(workspaceId, member.id, member.etag),
    onSuccess: () => { refresh(); toast.success("Member removed") }, onError: refresh })
  const update = useMutation({ mutationFn: (role: WorkspaceRole) => api.updateMemberRole(workspaceId, member.id, role, member.etag),
    onSuccess: () => { refresh(); toast.success("Role updated") }, onError: refresh })
  const canRemove = can("member.remove") && !member.tenantOwner
  const canUpdate = can("member.update") && !member.tenantOwner
  if (!canRemove && !canUpdate) return null
  const busy = remove.isPending || update.isPending
  return <div>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" disabled={busy || !member.etag} aria-label={`Actions for ${member.name}`}>
        <MoreHorizontal className="h-4 w-4" />
      </Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canUpdate && WORKSPACE_ROLES.map(role => <DropdownMenuItem key={role} disabled={role === member.role || busy}
          onClick={() => update.mutate(role)}>Make {role[0].toUpperCase() + role.slice(1)}</DropdownMenuItem>)}
        {canRemove && <><DropdownMenuSeparator /><DropdownMenuItem disabled={busy} className="text-danger" onClick={() => {
          if (confirm(`Remove ${member.name}? They will immediately lose access to this workspace.`)) remove.mutate()
        }}>Remove member</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
    {(remove.error || update.error) && <p role="alert" className="text-sm text-danger">{(remove.error || update.error)?.message}</p>}
  </div>
}
