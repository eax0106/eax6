import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"

export function WorkflowFolderSidebar() {
  const folders = useQuery({ queryKey: queryKeys.workflowFolders, queryFn: () => api.getWorkflowFolders() })
  const workflows = useQuery({ queryKey: queryKeys.workflows.all, queryFn: () => api.getWorkflows() })
  if (folders.isLoading || workflows.isLoading) return <p role="status">Loading workflow folders…</p>
  if (folders.error || workflows.error) return <div role="alert">Workflow folders unavailable. <button onClick={() => { void folders.refetch(); void workflows.refetch() }}>Retry folders</button></div>
  const groups = [...(folders.data?.data ?? []).map(folder => ({ id: folder.id, name: folder.name })), { id: null, name: "Ungrouped" }]
  return <nav aria-label="Workflow folders" className="space-y-2 px-2 text-sm">
    {groups.map(folder => <details key={folder.id ?? "ungrouped"} open>
      <summary><Link to={`/app/workflows?folder=${folder.id ?? "ungrouped"}`}>{folder.name}</Link></summary>
      <ul className="pl-3">
        {(workflows.data ?? []).filter(workflow => (workflow.folderId ?? null) === folder.id).map(workflow =>
          <li key={workflow.id}><Link className="block truncate py-1" to={`/app/workflows/${workflow.id}`}>{workflow.name}</Link></li>)}
      </ul>
    </details>)}
  </nav>
}
