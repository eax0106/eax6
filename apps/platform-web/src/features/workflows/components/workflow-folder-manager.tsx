import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import type { WorkflowFolder } from "@alterx/contracts"
import { api } from "@/api/client"
import { ApiHttpError } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"

export function WorkflowFolderManager() {
  const query = useQuery({ queryKey: queryKeys.workflowFolders, queryFn: () => api.getWorkflowFolders() })
  const client = useQueryClient()
  const [name, setName] = useState(""), [editing, setEditing] = useState<WorkflowFolder | null>(null), [deleting, setDeleting] = useState<WorkflowFolder | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState("")
  const reload = async () => {
    await Promise.all([query.refetch({ throwOnError: true }), client.invalidateQueries({ queryKey: queryKeys.workflows.all })])
    setEditing(null); setDeleting(null); setName(""); setError("")
  }
  const change = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError("")
    try { await operation(); await reload() }
    catch (failure) { setError(failure instanceof ApiHttpError && failure.status === 412 ? "Folders changed. Reload before editing again." : failure instanceof Error ? failure.message : "Folder change failed") }
    finally { setBusy(false) }
  }
  if (query.isLoading) return <p role="status">Loading folders…</p>
  if (query.error) return <div role="alert">Folders unavailable. <Button onClick={() => void query.refetch()}>Retry folders</Button></div>
  return <section aria-label="Manage workflow folders" className="space-y-3 rounded-xl border p-4">
    <div className="flex flex-wrap gap-3">
      <Link to="/app/workflows?folder=ungrouped">Ungrouped</Link>
      {query.data?.data.map(folder => <div key={folder.id}>
        <Link to={`/app/workflows?folder=${folder.id}`}>{folder.name}</Link>
        {query.data.canEdit && <>
          <Button variant="ghost" disabled={busy} onClick={() => { setEditing(folder); setDeleting(null); setName(folder.name) }}>Rename {folder.name}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setDeleting(folder); setEditing(null) }}>Delete {folder.name}</Button>
        </>}
      </div>)}
    </div>
    {query.data?.canEdit && !deleting && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void change(() => editing ? api.renameWorkflowFolder(editing, name) : api.createWorkflowFolder(name)) }}>
      <label>{editing ? "Folder name" : "New folder name"}<input aria-label={editing ? "Folder name" : "New folder name"} className="ml-2 border rounded px-2 py-1" value={name} onChange={event => setName(event.target.value)} required maxLength={160} disabled={busy} /></label>
      <Button disabled={busy || !name.trim()} type="submit">{editing ? "Save folder name" : "Create folder"}</Button>
      {editing && <Button variant="outline" type="button" disabled={busy} onClick={() => { setEditing(null); setName("") }}>Cancel rename</Button>}
    </form>}
    {deleting && <div>
      <p>Delete {deleting.name}? Its workflows return to Ungrouped. Workflows, chats and runs remain.</p>
      <Button disabled={busy} onClick={() => void change(() => api.deleteWorkflowFolder(deleting))}>Confirm delete folder</Button>
      <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>Cancel delete</Button>
    </div>}
    {error && <div role="alert">{error} <Button disabled={busy} onClick={() => void reload().catch(failure => setError(failure instanceof Error ? failure.message : "Folder reload failed"))}>Reload folders</Button></div>}
  </section>
}
