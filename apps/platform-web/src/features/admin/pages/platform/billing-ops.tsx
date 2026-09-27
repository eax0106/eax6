import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCcw, HandCoins } from "lucide-react"

export function BillingOpsQueue() {
  const queryClient = useQueryClient()
  
  const { data: issues, isLoading } = useQuery({
    queryKey: queryKeys.admin.billing.issues,
    queryFn: () => api.admin.billing.listIssues()
  })

  const resolveMutation = useMutation({
    mutationFn: (id: string) => api.admin.billing.resolve(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.billing.issues })
  })

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.admin.billing.retryBilling(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.billing.issues })
  })

  const applyCreditMutation = useMutation({
    mutationFn: ({ tenantId, amount }: { tenantId: string, amount: number }) => api.admin.billing.applyCredit(tenantId, amount, "Admin adjustment"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.billing.issues })
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <PageHeader 
        title="Billing Operations"
        description="Manage failed payments, renewals, and credit requests."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Tenant</TableHead>
              <TableHead className="text-slate-400">Issue</TableHead>
              <TableHead className="text-slate-400">Amount</TableHead>
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
            ) : issues?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  No billing issues found.
                </TableCell>
              </TableRow>
            ) : (
              issues?.map((i) => (
                <TableRow key={i.id} className="border-slate-800">
                  <TableCell>
                    <div className="font-medium text-slate-200">{i.tenantName}</div>
                    <div className="text-xs text-slate-500 font-mono">{i.tenantId}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-slate-800 text-slate-300 border-slate-700 capitalize">
                      {i.issue.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {i.amount === undefined ? (
                      <span className="text-slate-500">—</span>
                    ) : (
                      <>
                        <span className="font-medium text-slate-200">${i.amount.toFixed(2)}</span>
                        <span className="text-xs text-slate-500 ml-1">{i.currency}</span>
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={
                      i.status === "resolved" ? "text-emerald-400 border-emerald-400/20" :
                      "text-amber-400 border-amber-400/20"
                    }>
                      {i.accessState ?? i.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-slate-400">
                    {new Date(i.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {!isLiveApi && (
                    <div className="flex justify-end gap-2">
                      {i.status === "open" && i.issue.includes("failed") && (
                        <Button variant="ghost" size="sm" onClick={() => retryMutation.mutate(i.id)} className="text-primary hover:text-primary hover:bg-primary-soft">
                          <RefreshCcw className="w-4 h-4 mr-2" /> Retry
                        </Button>
                      )}
                      {i.status === "open" && i.issue === "credit_request" && (
                        <Button variant="ghost" size="sm" onClick={() => {
                          applyCreditMutation.mutate({ tenantId: i.tenantId, amount: i.amount })
                          resolveMutation.mutate(i.id)
                        }} className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10">
                          <HandCoins className="w-4 h-4 mr-2" /> Apply
                        </Button>
                      )}
                      {i.status === "open" && (
                        <Button variant="ghost" size="sm" onClick={() => resolveMutation.mutate(i.id)} className="text-slate-400 hover:text-slate-300 hover:bg-slate-800">
                          Dismiss
                        </Button>
                      )}
                    </div>
                    )}
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
