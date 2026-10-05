
import * as React from "react"
import { useParams, Link } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { isLiveApi } from "@/api/http"
import { getStaffSession } from "@/api/staff-auth"
import { AdminNoteComposer } from "../../components/admin-note-composer"
import { TenantActivity } from "./tenant-activity"

import { Card } from "@/components/ui/card"
import { StatusBadge } from "@/components/common/status-badge"
import { Button } from "@/components/ui/button"
import { Loader2, ArrowLeft, Shield, CheckCircle2 } from "lucide-react"

export function TenantDetail() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const queryClient = useQueryClient()

  // Live: staff_admin and staff_support read a tenant only under an active,
  // reason-coded support grant (enforced by platform-api); other staff roles
  // need none. Demo mode needs none.
  const session = useQuery({ queryKey: ["staff", "session"], queryFn: getStaffSession, enabled: isLiveApi })
  const needsGrant =
    isLiveApi && (session.data?.roles ?? []).some((role) => role === "staff_admin" || role === "staff_support")
  const grant = useQuery({
    queryKey: ["admin", "tenants", tenantId, "grant"],
    queryFn: async () => (await api.admin.tenants.activeGrant(tenantId!)) ?? null,
    enabled: !!tenantId && needsGrant,
  })
  const grantId = grant.data?.id
  const canRead = !!tenantId && (!needsGrant || !!grantId) && (!isLiveApi || !!session.data)

  const tenantQuery = useQuery({
    queryKey: [...queryKeys.admin.tenants.detail(tenantId!), grantId],
    queryFn: () => api.admin.tenants.get(tenantId!, grantId),
    enabled: canRead
  })
  const { data: tenant, isLoading } = tenantQuery

  const { data: notes, isLoading: notesLoading, error: notesError } = useQuery({
    queryKey: [...queryKeys.admin.tenants.notes(tenantId!), grantId],
    queryFn: () => api.admin.tenants.getNotes(tenantId!, grantId),
    enabled: canRead
  })

  const suspendMutation = useMutation({
    mutationFn: () => api.admin.tenants.suspend(tenantId!, "Admin intervention"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants.detail(tenantId!) })
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants.notes(tenantId!) })
    }
  })

  const restoreMutation = useMutation({
    mutationFn: () => api.admin.tenants.restore(tenantId!, "Admin intervention"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants.detail(tenantId!) })
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants.notes(tenantId!) })
    }
  })

  if (needsGrant && grant.isSuccess && !grantId) {
    return (
      <RequestTenantAccess
        tenantId={tenantId!}
        isAdmin={(session.data?.roles ?? []).includes("staff_admin")}
        onGranted={() => queryClient.invalidateQueries({ queryKey: ["admin", "tenants", tenantId, "grant"] })}
      />
    )
  }

  if (isLoading || session.isLoading || grant.isLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    )
  }

  const readError = session.error ?? grant.error ?? tenantQuery.error
  if (readError) return <div className="p-8 space-y-3"><p role="alert">{readError instanceof Error ? readError.message : "Tenant detail unavailable"}</p>
    <Button onClick={() => { if (session.error) void session.refetch(); else if (grant.error) void grant.refetch(); else void tenantQuery.refetch() }}>Reload tenant detail</Button></div>

  if (!tenant) return <div className="p-8 text-slate-400">Tenant not found</div>

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
      <Link to="/app/admin/tenants" className="inline-flex items-center text-sm text-slate-400 hover:text-slate-200 transition-colors">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Tenants
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-3">
            {tenant.name}
            <StatusBadge status={tenant.status} />
          </h1>
          <p className="text-slate-400 mt-1">ID: {tenant.id}{tenant.slug ? ` • Slug: ${tenant.slug}` : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {tenant.status === "active" ? (
            <Button variant="danger" size="sm" onClick={() => suspendMutation.mutate()} disabled={suspendMutation.isPending}>
              {suspendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Shield className="w-4 h-4 mr-2" />}
              Suspend Tenant
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => restoreMutation.mutate()} disabled={restoreMutation.isPending}>
              {restoreMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Restore Tenant
            </Button>
          )}
        </div>
      </div>

      <div>
        <Card className="p-4 bg-slate-900 border-slate-800">
          <p className="text-sm text-slate-400">Plan</p>
          <p className="text-lg font-medium text-slate-200 capitalize mt-1">{tenant.plan ?? "—"}</p>
        </Card>
      </div>
      {canRead && <TenantActivity tenantId={tenantId!} {...(grantId ? { grantId } : {})} />}

      <div className="space-y-4">
        <h3 className="text-lg font-medium text-slate-200">Admin Notes</h3>
        {canRead && (!isLiveApi || session.data?.roles.some(role => ["staff_admin", "staff_support", "staff_billing_ops", "staff_security"].includes(role))) && <AdminNoteComposer append={async body => {
          const note = await api.admin.tenants.addNote(tenantId!, body, grantId)
          await queryClient.invalidateQueries({queryKey: queryKeys.admin.tenants.notes(tenantId!)})
          return note
        }} />}
        {notesError && <p role="alert" className="text-destructive">{notesError instanceof Error ? notesError.message : "Notes are unavailable"}</p>}
        {notesLoading ? (
          <div className="p-4 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
        ) : notes?.length === 0 ? (
          <Card className="p-4 bg-slate-900/50 border-slate-800 border-dashed text-center text-slate-500">
            No administrative notes.
          </Card>
        ) : (
          <div className="space-y-3">
            {notes?.map(note => (
              <Card key={note.id} className="p-4 bg-slate-900 border-slate-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm text-slate-200">{note.author.name}</span>
                  <span className="text-xs text-slate-500">{new Date(note.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-sm text-slate-300">{note.body}</p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RequestTenantAccess({
  tenantId,
  isAdmin,
  onGranted,
}: {
  tenantId: string
  isAdmin: boolean
  onGranted: () => void
}) {
  const [reason, setReason] = React.useState("")
  const [minutes, setMinutes] = React.useState(60)
  const request = useMutation({
    mutationFn: () => api.admin.tenants.requestAccess(tenantId, reason.trim(), minutes),
    onSuccess: onGranted,
  })
  return (
    <div className="max-w-xl mx-auto p-6">
      <Card className="p-6 bg-slate-900 border-slate-800 space-y-4">
        <h1 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
          <Shield className="w-5 h-5" /> Support access required
        </h1>
        <p className="text-sm text-slate-400">
          Reading a tenant needs an active, time-boxed support grant with a reason. Every grant is audited and visible
          to the tenant.
        </p>
        {isAdmin ? (
          <>
            <label className="block text-sm text-slate-300">
              Reason
              <textarea
                aria-label="Reason"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-slate-100"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="block text-sm text-slate-300">
              Duration (minutes)
              <input
                aria-label="Duration (minutes)"
                type="number"
                min={1}
                max={480}
                className="mt-1 w-32 rounded-md border border-slate-700 bg-slate-950 p-2 text-slate-100"
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
            </label>
            {request.isError && (
              <p className="text-sm text-red-400">
                {request.error instanceof Error ? request.error.message : "Access could not be granted"}
              </p>
            )}
            <Button
              onClick={() => request.mutate()}
              disabled={!reason.trim() || minutes < 1 || minutes > 480 || request.isPending}
            >
              {request.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Grant access"}
            </Button>
          </>
        ) : (
          <p className="text-sm text-slate-300">Ask a staff admin to grant you support access to this tenant.</p>
        )}
      </Card>
    </div>
  )
}
