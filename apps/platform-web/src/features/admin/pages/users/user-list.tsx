import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { StatusBadge } from "@/components/common/status-badge"
import { Loader2 } from "lucide-react"
import { Link } from "react-router-dom"

export function UserList() {
  const { data: users, isLoading } = useQuery({
    queryKey: queryKeys.admin.users.list,
    queryFn: () => api.admin.users.list()
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <PageHeader 
        title="Users"
        description="Manage individual platform users."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Name / Email</TableHead>
              <TableHead className="text-slate-400">Status</TableHead>
              <TableHead className="text-slate-400">Tenants</TableHead>
              <TableHead className="text-slate-400">MFA</TableHead>
              <TableHead className="text-slate-400 text-right">Risk</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : users?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-slate-500">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              users?.map((u) => (
                <TableRow key={u.id} className="border-slate-800 hover:bg-slate-800/50 cursor-pointer group">
                  <TableCell>
                    <Link to={`/app/admin/users/${u.id}`} className="block">
                      <div className="font-medium text-slate-200 group-hover:text-primary transition-colors">
                        {u.name}
                      </div>
                      <div className="text-xs text-slate-500">{u.email}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={u.status} />
                  </TableCell>
                  <TableCell>
                    <span className="text-slate-300">{u.tenantIds.length}</span>
                  </TableCell>
                  <TableCell>
                    <span className={u.mfaEnabled === undefined ? "text-slate-500" : u.mfaEnabled ? "text-emerald-400" : "text-amber-400"}>
                      {u.mfaEnabled === undefined ? "—" : u.mfaEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {u.riskState ? <StatusBadge status={u.riskState} /> : <span className="text-slate-500">—</span>}
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
