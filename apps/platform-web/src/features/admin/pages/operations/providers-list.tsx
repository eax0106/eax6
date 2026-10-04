import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, Power, PowerOff } from "lucide-react"

export function ProvidersList() {
  const queryClient = useQueryClient()

  const { data: providers, isLoading } = useQuery({
    queryKey: queryKeys.admin.providers.list,
    queryFn: () => api.admin.providers.list()
  })

  const enableMutation = useMutation({
    mutationFn: (id: string) => api.admin.providers.enable(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.providers.list })
  })

  const disableMutation = useMutation({
    mutationFn: (id: string) => api.admin.providers.disable(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.providers.list })
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <PageHeader 
        title="Infrastructure Providers"
        description="Monitor and manage model, compute, and storage providers."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Provider</TableHead>
              <TableHead className="text-slate-400">Type</TableHead>
              <TableHead className="text-slate-400">Status</TableHead>
              <TableHead className="text-slate-400">Latency</TableHead>
              <TableHead className="text-slate-400">Error Rate</TableHead>
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
            ) : providers?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  No providers found.
                </TableCell>
              </TableRow>
            ) : (
              providers?.map((p) => (
                <TableRow key={p.id} className={`border-slate-800 ${!p.enabled ? 'opacity-60' : ''}`}>
                  <TableCell>
                    <div className="font-medium text-slate-200">{p.name}</div>
                    <div className="text-xs text-slate-500">{p.region}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize text-slate-300 border-slate-700 bg-slate-800/50">
                      {p.type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={
                      p.status === "healthy" ? "text-emerald-400 border-emerald-400/20" :
                      p.status === "degraded" ? "text-amber-400 border-amber-400/20" :
                      p.status === "outage" ? "text-red-400 border-red-400/20" :
                      "text-slate-400 border-slate-700"
                    }>
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`text-sm ${p.latencyMs && p.latencyMs > 1000 ? 'text-amber-400' : 'text-slate-300'}`}>
                      {p.latencyMs}ms
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={`text-sm ${p.errorRate && p.errorRate > 1 ? 'text-red-400' : 'text-slate-300'}`}>
                      {p.errorRate}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {p.enabled ? (
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          title="Disable Provider"
                          onClick={() => disableMutation.mutate(p.id)}
                          className="h-8 w-8 text-slate-400 hover:bg-red-500/10 hover:text-red-400"
                        >
                          <PowerOff className="w-4 h-4" />
                        </Button>
                      ) : (
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          title="Enable Provider"
                          onClick={() => enableMutation.mutate(p.id)}
                          className="h-8 w-8 text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-400"
                        >
                          <Power className="w-4 h-4" />
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
