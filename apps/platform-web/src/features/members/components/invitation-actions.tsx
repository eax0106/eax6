import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import type { WorkspaceInvitation } from "@/api/types"
import { Button } from "@/components/ui/button"

export function InvitationActions({ invitation, workspaceId }: { invitation: WorkspaceInvitation; workspaceId: string }) {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.members.all(workspaceId) })
  const resend = useMutation({ mutationFn: () => api.resendInvite(workspaceId, invitation.id, invitation.etag), onSuccess: refresh, onError: refresh })
  const revoke = useMutation({ mutationFn: () => api.revokeInvite(workspaceId, invitation.id, invitation.etag), onSuccess: refresh, onError: refresh })
  const busy = resend.isPending || revoke.isPending
  const resendable = ["pending", "expired", "delivery_failed"].includes(invitation.status) ||
    (invitation.status === "delivering" && Date.parse(invitation.updatedAt) <= Date.now() - 60000)
  const revocable = !["accepted", "revoked"].includes(invitation.status)
  return <div className="space-y-2">
    <div className="flex gap-2 justify-end">
      {resendable && <Button variant="outline" size="sm" disabled={busy || !invitation.etag} onClick={() => resend.mutate()}>Resend invitation</Button>}
      {revocable && <Button variant="ghost" size="sm" disabled={busy || !invitation.etag} onClick={() => {
        if (confirm(`Revoke invitation for ${invitation.email}?`)) revoke.mutate()
      }}>Revoke invitation</Button>}
    </div>
    {(resend.error || revoke.error) && <p role="alert" className="text-danger">{(resend.error || revoke.error)?.message}</p>}
  </div>
}
