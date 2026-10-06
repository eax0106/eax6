import * as React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { RequirePermission } from "@/features/permissions/components/require-permission"

export function WorkspaceSettings() {
  return (
    <RequirePermission permission="workspace.manage">
      <div className="space-y-10">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Workspace General Settings</h1>
          <p className="text-text-secondary mt-2">Manage your workspace identity and configuration.</p>
        </div>

        <WorkspaceIdentityForm />
        <RunHistoryRetention />
        <DangerZone />
      </div>
    </RequirePermission>
  )
}

function WorkspaceIdentityForm() {
  const queryClient = useQueryClient()
  
  // Using the first workspace as the "current" one for the mock
  const { data: workspaces, isLoading } = useQuery({
    queryKey: queryKeys.workspace.all,
    queryFn: () => api.getWorkspaces(),
  })
  
  const currentWorkspace = workspaces?.[0]
  
  const [name, setName] = React.useState("")
  const [slug, setSlug] = React.useState("")
  
  React.useEffect(() => {
    if (currentWorkspace) {
      setName(currentWorkspace.name)
      setSlug(currentWorkspace.slug)
    }
  }, [currentWorkspace])

  const { mutate, isPending } = useMutation({
    mutationFn: (data: { name: string; slug: string }) => {
      if (!currentWorkspace) throw new Error("No workspace")
      return api.updateWorkspace(currentWorkspace.id, data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace.all })
      toast.success("Workspace settings saved")
    },
    onError: () => {
      toast.error("Failed to update workspace")
    }
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    mutate({ name, slug })
  }

  if (isLoading || !currentWorkspace) {
    return <div className="h-64 flex items-center justify-center border rounded-xl border-border"><Loader2 className="animate-spin text-text-muted" /></div>
  }

  const isDirty = name !== currentWorkspace.name || slug !== currentWorkspace.slug

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-6 py-5 border-b border-border">
        <h3 className="text-lg font-medium text-text-primary">Workspace Identity</h3>
      </div>
      <form onSubmit={handleSubmit} className="px-6 py-6 space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-primary">Workspace Name</label>
            <Input 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-primary">Workspace URL</label>
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-border bg-surface-hover px-3 text-sm text-text-muted">
                alterx.ai/
              </span>
              <Input 
                className="rounded-l-none"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={!isDirty || isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      </form>
    </div>
  )
}

function DangerZone() {
  const [showConfirm, setShowConfirm] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState("")
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: workspaces } = useQuery({
    queryKey: queryKeys.workspace.all,
    queryFn: () => api.getWorkspaces(),
  })

  const currentWorkspace = workspaces?.[0]

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!currentWorkspace) throw new Error("No workspace")
      return api.deleteWorkspace(currentWorkspace.id, confirmText)
    },
    onSuccess: ({ deletionDueAt }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace.all })
      toast.success(`Workspace scheduled for deletion. You can restore it until ${new Date(deletionDueAt).toLocaleString()}.`)
      setShowConfirm(false)
      setConfirmText("")
      navigate("/")
    },
    onError: () => {
      toast.error("Failed to delete workspace")
    }
  })

  const canDelete = confirmText === (currentWorkspace?.name ?? "")

  return (
    <>
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden mt-10">
        <div className="px-6 py-5 border-b border-red-500/20">
          <h3 className="text-lg font-medium text-red-500">Danger Zone</h3>
        </div>
        <div className="px-6 py-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-ax-text">Delete workspace</h4>
              <p className="text-sm text-ax-text-muted mt-1">
                Hide this workspace and stop its runs. You can restore it during a restore window (7 days by default); after that it and all of its data are permanently deleted.
              </p>
            </div>
            <Button variant="danger" onClick={() => setShowConfirm(true)}>
              Delete workspace
            </Button>
          </div>
        </div>
      </div>

      <PendingDeletionWorkspaces />

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-500">Delete Workspace</DialogTitle>
            <DialogDescription>
              <strong>{currentWorkspace?.name}</strong> will be hidden at once and no run will start in it. You can
              restore it during the restore window (7 days by default). After that it is permanently deleted with all of its workflows, projects, runs,
              knowledge and connections.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <label className="text-sm font-medium text-ax-text">
              Type <span className="font-mono text-red-400">{currentWorkspace?.name}</span> to confirm
            </label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={currentWorkspace?.name}
              autoFocus
            />
          </div>
          <DialogFooter className="pt-4">
            <Button variant="secondary" onClick={() => { setShowConfirm(false); setConfirmText("") }}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!canDelete || deleteMutation.isPending}
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** D2: workspaces waiting out their restore window, each with a restore action. */
export function PendingDeletionWorkspaces() {
  const queryClient = useQueryClient()
  const { data: pending } = useQuery({
    queryKey: queryKeys.workspace.pendingDeletion,
    queryFn: () => api.getPendingDeletionWorkspaces(),
    retry: false,
  })
  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.restoreWorkspace(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace.pendingDeletion })
      toast.success("Workspace restored")
    },
    onError: () => {
      toast.error("Failed to restore workspace")
    },
  })

  if (!pending || pending.length === 0) return null
  return (
    <div className="rounded-xl border border-ax-border overflow-hidden mt-6">
      <div className="px-6 py-5 border-b border-ax-border">
        <h3 className="text-lg font-medium text-ax-text">Pending deletion</h3>
      </div>
      <ul className="divide-y divide-ax-border">
        {pending.map((workspace) => (
          <li key={workspace.id} className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="font-medium text-ax-text">{workspace.name}</p>
              <p className="text-sm text-ax-text-muted">
                Deleted for good on {new Date(workspace.deletionDueAt).toLocaleString()}
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={restoreMutation.isPending}
              loading={restoreMutation.isPending && restoreMutation.variables === workspace.id}
              onClick={() => restoreMutation.mutate(workspace.id)}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * D2: how long finished runs are kept, 7 to 365 days. Lowering it first shows
 * how many runs it deletes and asks for confirmation.
 */
function RunHistoryRetention() {
  const queryClient = useQueryClient()
  const { data: retention } = useQuery({
    queryKey: queryKeys.workspace.runRetention,
    queryFn: () => api.runRetention.get(),
    retry: false,
  })
  const [days, setDays] = React.useState("")
  const [pendingLowering, setPendingLowering] = React.useState<{ days: number; runsToDelete: number } | null>(null)
  React.useEffect(() => {
    if (retention) setDays(String(retention.retentionDays))
  }, [retention])

  const saveMutation = useMutation({
    mutationFn: ({ value, confirm }: { value: number; confirm: boolean }) =>
      api.runRetention.set(value, confirm, retention!.etag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace.runRetention })
      setPendingLowering(null)
      toast.success("Run-history retention saved")
    },
    onError: () => {
      toast.error("Failed to save run-history retention")
    },
  })
  const previewMutation = useMutation({
    mutationFn: (value: number) => api.runRetention.preview(value),
    onSuccess: (runsToDelete, value) => setPendingLowering({ days: value, runsToDelete }),
    onError: () => {
      toast.error("Could not count the runs this would delete")
    },
  })

  if (!retention) return null
  const value = Number(days)
  const valid = Number.isInteger(value) && value >= 7 && value <= 365
  const lowering = valid && value < retention.retentionDays

  function save() {
    if (!valid) return
    if (lowering) previewMutation.mutate(value)
    else saveMutation.mutate({ value, confirm: false })
  }

  return (
    <div className="rounded-xl border border-ax-border overflow-hidden">
      <div className="px-6 py-5 border-b border-ax-border">
        <h3 className="text-lg font-medium text-ax-text">Run history</h3>
        <p className="text-sm text-ax-text-muted mt-1">
          Finished runs older than this are deleted each day, with their steps, outputs and verification results.
        </p>
      </div>
      <div className="px-6 py-6 flex items-end gap-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-ax-text">Keep runs for (days, 7 to 365)</span>
          <Input type="number" min={7} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <Button
          disabled={!valid || value === retention.retentionDays || saveMutation.isPending || previewMutation.isPending}
          loading={saveMutation.isPending || previewMutation.isPending}
          onClick={save}
        >
          Save
        </Button>
      </div>

      <Dialog open={pendingLowering !== null} onOpenChange={(open) => { if (!open) setPendingLowering(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-500">Delete older run history?</DialogTitle>
            <DialogDescription>
              Keeping runs for {pendingLowering?.days} days deletes {pendingLowering?.runsToDelete} finished runs
              now, and they cannot be recovered.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="pt-4">
            <Button variant="secondary" onClick={() => setPendingLowering(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={saveMutation.isPending}
              onClick={() => pendingLowering && saveMutation.mutate({ value: pendingLowering.days, confirm: true })}
            >
              Delete and save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
