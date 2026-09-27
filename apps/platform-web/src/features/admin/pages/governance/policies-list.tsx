import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, Plus } from "lucide-react"

export function PoliciesList() {
  const { data: policies, isLoading } = useQuery({
    queryKey: queryKeys.admin.policies.list,
    queryFn: () => api.admin.policies.list()
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader 
          title="Platform Policies"
          description="Manage global and tenant-specific platform policies."
        />
        <Button disabled><Plus className="w-4 h-4 mr-2" /> New Policy</Button>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Policy</TableHead>
              <TableHead className="text-slate-400">Category</TableHead>
              <TableHead className="text-slate-400">Scope</TableHead>
              <TableHead className="text-slate-400">Status</TableHead>
              <TableHead className="text-slate-400">Last Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : policies?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-slate-500">
                  No policies found.
                </TableCell>
              </TableRow>
            ) : (
              policies?.map((p) => (
                <TableRow key={p.id} className="border-slate-800 hover:bg-slate-800/50 cursor-pointer">
                  <TableCell>
                    <div className="font-medium text-slate-200">{p.name}</div>
                    <div className="text-xs text-slate-500">{p.description}</div>
                  </TableCell>
                  <TableCell>
                    <span className="capitalize text-slate-300">{p.category}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-slate-800 text-slate-300 border-slate-700 capitalize">
                      {p.scope}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={
                      p.status === "active" ? "text-emerald-400 border-emerald-400/20" :
                      p.status === "draft" ? "text-slate-400 border-slate-700" :
                      "text-amber-400 border-amber-400/20"
                    }>
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-slate-300">{p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : "—"}</div>
                    <div className="text-xs text-slate-500">{p.updatedBy?.name ?? ""}</div>
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
