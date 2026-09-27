import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { StatusBadge } from "@/components/common/status-badge"
import { Loader2 } from "lucide-react"
import { Link } from "react-router-dom"

export function TenantList() {
  const { data: tenants, isLoading } = useQuery({
    queryKey: queryKeys.admin.tenants.list,
    queryFn: () => api.admin.tenants.list()
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <PageHeader 
        title="Tenants"
        description="Manage workspace tenants across the platform."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Name</TableHead>
              <TableHead className="text-slate-400">Status</TableHead>
              <TableHead className="text-slate-400">Plan</TableHead>
              <TableHead className="text-slate-400 text-right">Members</TableHead>
              <TableHead className="text-slate-400 text-right">30d Runs</TableHead>
              <TableHead className="text-slate-400 text-right">Risk</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : tenants?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  No tenants found.
                </TableCell>
              </TableRow>
            ) : (
              tenants?.map((t) => (
                <TableRow key={t.id} className="border-slate-800 hover:bg-slate-800/50 cursor-pointer group">
                  <TableCell>
                    <Link to={`/app/admin/tenants/${t.id}`} className="block">
                      <div className="font-medium text-slate-200 group-hover:text-primary transition-colors">
                        {t.name}
                      </div>
                      {t.slug && <div className="text-xs text-slate-500">{t.slug}</div>}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell>
                    <span className="capitalize text-slate-300">{t.plan ?? "—"}</span>
                  </TableCell>
                  <TableCell className="text-right text-slate-300">{t.memberCount ?? "—"}</TableCell>
                  <TableCell className="text-right text-slate-300">{t.runCount30d?.toLocaleString() ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <StatusBadge status={t.riskState || "normal"} />
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
