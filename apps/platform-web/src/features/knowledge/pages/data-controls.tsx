import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DownloadCloud, Trash2, AlertTriangle, ShieldCheck, RefreshCw } from "lucide-react"
import * as React from "react"

import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { Input } from "@/components/ui/input"
import { PendingDeletionWorkspaces } from "@/features/workspace/pages/workspace-settings"
import type { DataExport } from "@/api/live-data-export"

function statusLabel(status: DataExport["status"]): string {
  if (status === "ready") return "Ready"
  if (status === "failed") return "Failed"
  if (status === "expired") return "Expired"
  if (status === "running") return "Building"
  return "Requested"
}

function downloadFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function DataControlsPage() {
  const queryClient = useQueryClient()
  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspace.all,
    queryFn: () => api.getWorkspaces(),
  })
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState<string | null>(null)
  const workspaceId = workspacesQuery.data?.find((workspace) => workspace.id === selectedWorkspaceId)?.id ?? workspacesQuery.data?.[0]?.id

  const exportsQuery = useQuery({
    queryKey: workspaceId ? queryKeys.dataExport.list(workspaceId) : ["dataExport", "list", "none"],
    queryFn: () => (workspaceId ? api.listDataExports(workspaceId) : Promise.resolve([] as DataExport[])),
    enabled: Boolean(workspaceId),
    refetchInterval: (query) => {
      const items = (query.state.data ?? []) as DataExport[]
      return items.some((item) => item.status === "requested" || item.status === "running") ? 5000 : false
    },
  })
  const exports = (exportsQuery.data ?? []) as DataExport[]

  const exportMutation = useMutation({
    mutationFn: () => {
      if (!workspaceId) throw new Error("No workspace")
      return api.requestDataExport(workspaceId)
    },
    onSuccess: () => {
      if (workspaceId) void queryClient.invalidateQueries({ queryKey: queryKeys.dataExport.list(workspaceId) })
    },
  })

  const [downloadingId, setDownloadingId] = React.useState<string | null>(null)
  const [downloadError, setDownloadError] = React.useState<string | null>(null)
  async function download(item: DataExport) {
    if (!workspaceId || downloadingId) return
    setDownloadingId(item.id)
    setDownloadError(null)
    try {
      const archive = await api.downloadDataExport(workspaceId, item.id)
      downloadFile(`workspace-export-${item.id}.json`, JSON.stringify(archive, null, 2))
    } catch {
      setDownloadError("Download failed. The export may have expired; request a new one.")
    } finally {
      setDownloadingId(null)
    }
  }

  const workspace = workspacesQuery.data?.find(item => item.id === workspaceId)
  const [confirmName, setConfirmName] = React.useState("")
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteWorkspaceData(isLiveApi ? workspaceId! : "all", isLiveApi ? confirmName : undefined),
    onSuccess: () => {
      if (isLiveApi) {
        setConfirmName("")
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspace.all })
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspace.pendingDeletion })
      }
    },
  })

  const pending = exports.filter((item) => item.status === "requested" || item.status === "running")

  return (
    <div className="flex-1 p-8 overflow-y-auto max-w-4xl mx-auto w-full">
      <PageHeader
        title="Data & Privacy Controls"
        description="Manage your workspace data, export your information, and control data retention."
      />

      <div className="space-y-6 mt-6">
        {workspacesQuery.data && workspacesQuery.data.length > 0 && (
          <label className="flex items-center gap-3 text-sm">
            Workspace
            <select aria-label="Export workspace" className="rounded-md border p-2 bg-background"
              value={workspaceId} disabled={exportMutation.isPending || Boolean(downloadingId) || deleteMutation.isPending}
              onChange={(event) => { setSelectedWorkspaceId(event.target.value); setDownloadError(null); setConfirmName(""); deleteMutation.reset() }}>
              {workspacesQuery.data.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
        )}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <DownloadCloud className="h-5 w-5 text-primary" />
              <CardTitle>Data Export</CardTitle>
            </div>
            <CardDescription>
              Download a complete archive of your workspace data, including workflows, run metadata, knowledge metadata, and members.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>The export is prepared as JSON and may take several minutes depending on the size of your workspace. Archives expire after 7 days.</p>
            {exportMutation.isError && (
              <div className="p-3 bg-destructive/10 text-destructive border border-destructive/20 rounded-md font-medium">
                Export request failed. Try again.
              </div>
            )}
            {exportsQuery.isLoading && <p>Loading exports…</p>}
            {workspacesQuery.isError && <p role="alert">Workspaces unavailable. Try again.</p>}
            {!workspacesQuery.isLoading && !workspacesQuery.isError && workspacesQuery.data?.length === 0 && <p>No available workspace.</p>}
            {exportsQuery.isError && <p role="alert">Exports unavailable. Try again.</p>}
            {!exportsQuery.isLoading && !exportsQuery.isError && !workspacesQuery.isError && workspaceId && exports.length === 0 && (
              <p>No exports yet. Request one below.</p>
            )}
            {exports.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 p-3 border rounded-md">
                <div>
                  <span className="font-medium">{statusLabel(item.status)}</span>
                  <span className="ml-2 text-xs">requested {new Date(item.requestedAt).toLocaleString()}</span>
                  {item.status === "failed" && item.failureReason && (
                    <div className="text-destructive text-xs mt-1">{item.failureReason}</div>
                  )}
                  {item.status === "expired" && (
                    <div className="text-xs mt-1">Expired. Request a new export.</div>
                  )}
                </div>
                {item.status === "ready" && (
                  <Button variant="outline" disabled={downloadingId === item.id} onClick={() => void download(item)}>
                    {downloadingId === item.id ? "Downloading…" : "Download"}
                  </Button>
                )}
              </div>
            ))}
            {pending.length > 0 && (
              <div className="p-3 bg-green-500/10 text-green-600 border border-green-500/20 rounded-md font-medium flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Export building. This list refreshes automatically.
              </div>
            )}
            {downloadError && (
              <div className="p-3 bg-destructive/10 text-destructive border border-destructive/20 rounded-md font-medium">
                {downloadError}
              </div>
            )}
          </CardContent>
          <CardFooter className="border-t px-6 py-4">
            <Button
              onClick={() => {
                setDownloadError(null)
                exportMutation.mutate()
              }}
              disabled={exportMutation.isPending || !workspaceId}
            >
              {exportMutation.isPending ? (
                <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" />Requesting…</span>
              ) : (
                "Request Data Export"
              )}
            </Button>
          </CardFooter>
        </Card>

        {isLiveApi && <>
          {workspace && <Card className="border-destructive/50">
            <CardHeader><CardTitle>Workspace deletion</CardTitle>
              <CardDescription>Hide this workspace and stop new runs. Restore it within the restore window (7 days by default); after that, its data is permanently deleted.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="block space-y-2">
                <span>Type {workspace.name} exactly to confirm</span>
                <Input aria-label="Workspace name to confirm deletion" value={confirmName} onChange={event => setConfirmName(event.target.value)} />
              </label>
              {deleteMutation.isError && <p role="alert">Workspace deletion failed. Try again.</p>}
              {deleteMutation.isSuccess && deleteMutation.data && <p role="status">Workspace scheduled for deletion. Restore until {new Date(deleteMutation.data.deletionDueAt).toLocaleString()}.</p>}
            </CardContent>
            <CardFooter><Button variant="danger" disabled={deleteMutation.isPending || confirmName !== workspace.name} onClick={() => deleteMutation.mutate()}>
              {deleteMutation.isPending ? "Scheduling…" : "Delete workspace"}
            </Button></CardFooter>
          </Card>}
          <PendingDeletionWorkspaces />
        </>}

        {!isLiveApi && (
          <Card className="border-destructive/50 shadow-sm shadow-destructive/10">
            <CardHeader>
              <div className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                <CardTitle>Data Deletion</CardTitle>
              </div>
              <CardDescription className="text-destructive/80">
                Permanently delete specific segments of data or your entire workspace.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                <div className="text-sm text-destructive">
                  <span className="font-semibold block mb-1">Warning: This action cannot be undone.</span>
                  Deleting your workspace data will immediately remove all access to workflows, runs, and connected knowledge sources.
                </div>
              </div>
              {deleteMutation.isSuccess && (
                <div className="text-sm font-medium text-destructive mt-2">
                  Deletion process initiated. You will be signed out shortly.
                </div>
              )}
            </CardContent>
            <CardFooter className="border-t border-destructive/20 px-6 py-4 bg-destructive/5">
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm("Are you absolutely sure? This will delete all mock data.")) {
                    deleteMutation.mutate()
                  }
                }}
                disabled={deleteMutation.isPending || deleteMutation.isSuccess}
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete All Workspace Data"}
              </Button>
            </CardFooter>
          </Card>
        )}
      </div>
    </div>
  )
}
