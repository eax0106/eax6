import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import type { SecurityReviewItem } from "@/api/types"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Select } from "@/components/ui/select"
export function SecurityQueue() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<{ item: SecurityReviewItem; action: "assign" | "resolved" | "dismissed" } | null>(null)
  const [staffId, setStaffId] = useState(""), [reason, setReason] = useState("")
  const query = useQuery({ queryKey: queryKeys.admin.security.list, queryFn: () => api.admin.security.list(), retry: false })
  const staff = useQuery({ queryKey: [...queryKeys.admin.security.list, "staff"], queryFn: () => api.admin.security.staff(), enabled: selected?.action === "assign", retry: false })
  const mutation = useMutation({
    mutationFn: async () => {
      if (!selected?.item.etag) throw new Error("Reload the current security review")
      return selected.action === "assign" ? api.admin.security.assign(selected.item.id, staffId, reason.trim(), selected.item.etag)
        : api.admin.security.resolve(selected.item.id, selected.action, reason.trim(), selected.item.etag)
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.admin.security.list }); setSelected(null) },
  })
  function choose(item: SecurityReviewItem, action: "assign" | "resolved" | "dismissed") {
    setSelected({ item, action }); setReason(""); setStaffId(""); mutation.reset()
  }
  return <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
    <PageHeader title="Security & Abuse Queue" description="Review anomalous behavior and policy violations." />
    {query.isLoading && <p role="status">Loading security reviews…</p>}
    {query.isError && <Card className="p-4"><p role="alert">{query.error instanceof Error ? query.error.message : "Security reviews unavailable"}</p><Button onClick={() => query.refetch()}>Reload reviews</Button></Card>}
    {selected && <Card className="p-4 space-y-3" aria-label="Security review action">
      <h2>{selected.action === "assign" ? "Assign security review" : "Record review decision"}</h2><p>{selected.item.title}</p>
      {selected.action === "assign" && <>
        {staff.isLoading && <p role="status">Loading eligible staff…</p>}
        {staff.isError && <><p role="alert">{staff.error instanceof Error ? staff.error.message : "Eligible staff unavailable"}</p><Button onClick={() => staff.refetch()}>Reload staff</Button></>}
        {staff.isSuccess && !staff.data.length && <p>No active eligible staff members.</p>}
        <label>Assign to<Select aria-label="Assign to" value={staffId} onChange={event => setStaffId(event.target.value)} disabled={staff.isLoading || staff.isError || mutation.isPending}>
          <option value="">Choose staff member</option>{staff.data?.map(person => <option key={person.id} value={person.id}>{person.email}</option>)}
        </Select></label>
      </>}
      <label>Reason<textarea aria-label="Review reason" maxLength={1000} className="block w-full rounded-md border border-border bg-transparent p-2" value={reason} disabled={mutation.isPending} onChange={event => setReason(event.target.value)} /></label>
      {mutation.isError && <p role="alert">{mutation.error instanceof Error ? mutation.error.message : "Review action failed"}</p>}
      <div className="flex gap-2"><Button onClick={() => mutation.mutate()} disabled={!reason.trim() || !selected.item.etag || mutation.isPending || (selected.action === "assign" && (!staffId || staff.isError || !staff.data?.some(person => person.id === staffId)))}>
        {mutation.isPending ? "Saving…" : selected.action === "assign" ? "Save assignment" : "Save decision"}
      </Button><Button variant="ghost" disabled={mutation.isPending} onClick={() => setSelected(null)}>Cancel</Button>
      {mutation.isError && <Button onClick={() => { setSelected(null); void query.refetch() }}>Reload reviews</Button>}</div>
    </Card>}
    {query.data && <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto"><Table>
      <TableHeader><TableRow><TableHead>Issue</TableHead><TableHead>Tenant</TableHead><TableHead>Severity</TableHead><TableHead>Status</TableHead><TableHead>Assigned to</TableHead><TableHead>Created</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
      <TableBody>{query.data.length === 0 ? <TableRow><TableCell colSpan={7}>No security issues found.</TableCell></TableRow> : query.data.map(item => <TableRow key={item.id}>
        <TableCell><div>{item.title}</div><div className="text-xs text-slate-400">{item.summary}</div></TableCell><TableCell>{item.tenantId ?? "—"}</TableCell>
        <TableCell><Badge variant="outline">{item.severity.toUpperCase()}</Badge></TableCell><TableCell>{item.status}</TableCell>
        <TableCell>{item.assignment ? <><p>{item.assignment.staffEmail}</p><p className="text-xs text-slate-400">{item.assignment.reason}</p>{!item.assignment.active && <p>Assignee no longer eligible</p>}</> : "Unassigned"}</TableCell>
        <TableCell>{new Date(item.createdAt).toLocaleString()}</TableCell><TableCell>{["open", "investigating"].includes(item.status) && <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => choose(item, "assign")} disabled={!item.etag || mutation.isPending}>{item.assignment ? "Reassign" : "Assign"}</Button>
          <Button variant="ghost" size="sm" onClick={() => choose(item, "resolved")} disabled={!item.etag || mutation.isPending}>Resolve</Button>
          <Button variant="ghost" size="sm" onClick={() => choose(item, "dismissed")} disabled={!item.etag || mutation.isPending}>Dismiss</Button>
        </div>}</TableCell>
      </TableRow>)}</TableBody>
    </Table></div>}
  </div>
}
