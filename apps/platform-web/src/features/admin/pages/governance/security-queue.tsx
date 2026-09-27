import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { isLiveApi } from "@/api/http"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, CheckCircle2, UserCheck } from "lucide-react"

export function SecurityQueue() {
  const queryClient = useQueryClient()
  
  const { data: items, isLoading } = useQuery({
    queryKey: queryKeys.admin.security.list,
    queryFn: () => api.admin.security.list()
  })

  const resolveMutation = useMutation({
    mutationFn: (id: string) => api.admin.security.resolve(id, "resolved"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.security.list })
  })

  const assignMutation = useMutation({
    mutationFn: (id: string) => api.admin.security.assign(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.security.list })
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <PageHeader 
        title="Security & Abuse Queue"
        description="Review anomalous behavior and policy violations."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Issue</TableHead>
              <TableHead className="text-slate-400">Tenant / User</TableHead>
              <TableHead className="text-slate-400">Severity</TableHead>
              <TableHead className="text-slate-400">Status</TableHead>
              <TableHead className="text-slate-400">Created At</TableHead>
              <TableHead className="text-slate-400 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : items?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  No security issues found.
                </TableCell>
              </TableRow>
            ) : (
              items?.map((i) => (
                <TableRow key={i.id} className="border-slate-800">
                  <TableCell>
                    <div className="font-medium text-slate-200">{i.title}</div>
                    <div className="text-xs text-slate-500">{i.type.replace("_", " ")}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-slate-300 font-mono">{i.tenantId || "-"}</div>
                    <div className="text-xs text-slate-500 font-mono">{i.userId || "-"}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={
                      i.severity === "critical" ? "bg-red-500/10 text-red-400 border-red-500/20" :
                      i.severity === "high" ? "bg-orange-500/10 text-orange-400 border-orange-500/20" :
                      i.severity === "medium" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                      "bg-primary-soft text-primary border-primary"
                    }>
                      {i.severity.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={
                      i.status === "resolved" ? "text-emerald-400 border-emerald-400/20" :
                      i.status === "investigating" ? "text-primary border-primary" :
                      i.status === "dismissed" ? "text-slate-400 border-slate-700" :
                      "text-amber-400 border-amber-400/20"
                    }>
                      {i.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-slate-400">
                    {new Date(i.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {/* Live: abuse signals have no assignee (B1.8). */}
                      {!isLiveApi && i.status === "open" && (
                        <Button variant="ghost" size="sm" onClick={() => assignMutation.mutate(i.id)} className="text-primary hover:text-primary hover:bg-primary-soft">
                          <UserCheck className="w-4 h-4 mr-2" /> Investigate
                        </Button>
                      )}
                      {(i.status === "open" || i.status === "investigating") && (
                        <Button variant="ghost" size="sm" onClick={() => resolveMutation.mutate(i.id)} className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10">
                          <CheckCircle2 className="w-4 h-4 mr-2" /> Resolve
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
