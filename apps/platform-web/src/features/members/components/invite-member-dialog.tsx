import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { WORKSPACE_ROLES, type WorkspaceRole } from "@/api/types"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

interface InviteMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
}

export function InviteMemberDialog({ open, onOpenChange, workspaceId }: InviteMemberDialogProps) {
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<WorkspaceRole>("viewer")
  const queryClient = useQueryClient()

  const { mutate, isPending, error, reset } = useMutation({
    mutationFn: (data: { email: string; role: WorkspaceRole }) => 
      api.inviteMember(workspaceId, data.email, data.role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.all(workspaceId) })
      toast.success("Invitation sent")
      onOpenChange(false)
      setEmail("")
      setRole("viewer")
    },
    onError: () => { queryClient.invalidateQueries({ queryKey: queryKeys.members.all(workspaceId) }) },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    reset()
    if (email.trim()) {
      mutate({ email, role })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Send an invitation to join this workspace. Invitations expire after seven days.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <label htmlFor="invite-email" className="text-sm font-medium text-text-primary">Email address</label>
            <Input 
              id="invite-email"
              maxLength={320}
              disabled={isPending}
              type="email"
              autoFocus
              placeholder="teammate@company.com" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="invite-role" className="text-sm font-medium text-text-primary">Role</label>
            <select id="invite-role" disabled={isPending}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              value={role}
              onChange={(e) => setRole(e.target.value as WorkspaceRole)}
            >
              {WORKSPACE_ROLES.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
            </select>
            <p className="text-xs text-text-muted mt-1">
              Owners cannot be invited through this menu.
            </p>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
          <DialogFooter className="pt-4">
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
