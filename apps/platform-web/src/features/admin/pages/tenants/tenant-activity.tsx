import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { formatMinorCurrency } from "@/lib/formatters"

export function TenantActivity({ tenantId, grantId }: { tenantId: string; grantId?: string }) {
  const query = useQuery({ queryKey: [...queryKeys.admin.tenants.detail(tenantId), "activity", grantId],
    queryFn: () => api.admin.tenants.activity(tenantId, grantId), retry: false,
  })
  if (query.isLoading) return <p role="status">Loading tenant activity…</p>
  if (query.isError) return <Card className="p-4 space-y-3">
    <p role="alert">{query.error instanceof Error ? query.error.message : "Tenant activity unavailable"}</p>
    <Button onClick={() => query.refetch()}>Reload tenant activity</Button>
  </Card>
  if (!query.data) return null
  const data = query.data
  return <section aria-label="Tenant activity" className="space-y-4">
    <p className="text-sm text-slate-400">30-day period: {new Date(data.start_at).toLocaleString()} – {new Date(data.end_at).toLocaleString()}. Runs count their creation time; spend is billed execution usage.</p>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card className="p-4"><p>Members</p><p aria-label="Member count">{data.members.count.toLocaleString()}</p></Card>
      <Card className="p-4"><p>Workflows</p><p aria-label="Workflow count">{data.workflow_count.toLocaleString()}</p></Card>
      <Card className="p-4"><p>30d Runs</p><p aria-label="Thirty-day run count">{data.run_count.toLocaleString()}</p></Card>
      <Card className="p-4"><p>30d Billed Spend</p>{data.spend.currencies.length ? data.spend.currencies.map(total => <p key={total.currency}>{total.currency} {formatMinorCurrency(total.billed_minor, total.currency)}</p>) : <p>No cost events in this period.</p>}</Card>
    </div>
    <Card className="p-4 overflow-x-auto"><h3>Members</h3><p className="text-sm text-slate-400">Showing {data.members.members.length} of {data.members.count}.</p>
      {!data.members.members.length ? <p>No members.</p> : <table aria-label="Tenant members"><thead><tr><th>Name</th><th>Email</th><th>Tenant role</th></tr></thead><tbody>{data.members.members.map(member => <tr key={member.id}><td>{member.name ?? "—"}</td><td>{member.email}</td><td>{member.role}</td></tr>)}</tbody></table>}
    </Card>
    <Card className="p-4 overflow-x-auto"><h3>Workflows</h3><p className="text-sm text-slate-400">Showing {data.workflows.length} of {data.workflow_count}, most recently updated first.</p>
      {!data.workflows.length ? <p>No workflows.</p> : <table aria-label="Tenant workflows"><thead><tr><th>Name</th><th>ID</th><th>Workspace</th><th>Status</th></tr></thead><tbody>{data.workflows.map(workflow => <tr key={workflow.id}><td>{workflow.name}</td><td>{workflow.id}</td><td>{workflow.workspace_id}</td><td>{workflow.status}</td></tr>)}</tbody></table>}
    </Card>
    <Card className="p-4 overflow-x-auto"><h3>Recent runs</h3><p className="text-sm text-slate-400">Showing {data.runs.length} of {data.run_count} in this period, newest first.</p>
      {!data.runs.length ? <p>No runs in this period.</p> : <table aria-label="Tenant recent runs"><thead><tr><th>ID</th><th>Workflow</th><th>Status</th><th>Created</th></tr></thead><tbody>{data.runs.map(run => <tr key={run.id}><td>{run.id}</td><td>{run.workflow_id ?? "—"}</td><td>{run.status}</td><td>{new Date(run.created_at).toLocaleString()}</td></tr>)}</tbody></table>}
    </Card>
  </section>
}
