import { useParams, Link } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Card } from "@/components/ui/card"
import { StatusBadge } from "@/components/common/status-badge"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, ArrowLeft, Shield, AlertTriangle, Lock, Unlock } from "lucide-react"

export function UserDetail() {
  const { userId } = useParams<{ userId: string }>()
  const queryClient = useQueryClient()
  
  const { data: user, isLoading } = useQuery({
    queryKey: queryKeys.admin.users.detail(userId!),
    queryFn: () => api.admin.users.get(userId!),
    enabled: !!userId
  })

  const { data: notes, isLoading: notesLoading } = useQuery({
    queryKey: queryKeys.admin.users.notes(userId!),
    queryFn: () => api.admin.users.getNotes(userId!),
    enabled: !!userId
  })

  const suspendMutation = useMutation({
    mutationFn: () => api.admin.users.suspend(userId!, "Admin intervention"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.detail(userId!) })
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.notes(userId!) })
    }
  })

  const restoreMutation = useMutation({
    mutationFn: () => api.admin.users.restore(userId!, "Admin intervention"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.detail(userId!) })
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.notes(userId!) })
    }
  })

  const lockMutation = useMutation({
    mutationFn: () => api.admin.users.lockSessions(userId!, "Session lock"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.notes(userId!) })
    }
  })

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (!user) return <div className="p-8 text-slate-400">User not found</div>

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
      <Link to="/app/admin/users" className="inline-flex items-center text-sm text-slate-400 hover:text-slate-200 transition-colors">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Users
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-3">
            {user.name}
            <StatusBadge status={user.status} />
            {user.riskState && user.riskState !== "normal" && (
              <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <AlertTriangle className="w-3 h-3 mr-1" />
                Risk: {user.riskState}
              </Badge>
            )}
          </h1>
          <p className="text-slate-400 mt-1">{user.email} • ID: {user.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => lockMutation.mutate()} disabled={lockMutation.isPending}>
            {lockMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Lock className="w-4 h-4 mr-2" />}
            Lock Sessions
          </Button>
          {user.status === "active" ? (
            <Button variant="danger" size="sm" onClick={() => suspendMutation.mutate()} disabled={suspendMutation.isPending}>
              {suspendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Shield className="w-4 h-4 mr-2" />}
              Suspend
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => restoreMutation.mutate()} disabled={restoreMutation.isPending}>
              {restoreMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Unlock className="w-4 h-4 mr-2" />}
              Restore
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4 bg-slate-900 border-slate-800">
          <p className="text-sm text-slate-400">Created At</p>
          <p className="text-lg font-medium text-slate-200 mt-1">{new Date(user.createdAt).toLocaleDateString()}</p>
        </Card>
        <Card className="p-4 bg-slate-900 border-slate-800">
          <p className="text-sm text-slate-400">MFA Status</p>
          <p className={`text-lg font-medium mt-1 ${user.mfaEnabled === undefined ? "text-slate-500" : user.mfaEnabled ? "text-emerald-400" : "text-amber-400"}`}>
            {user.mfaEnabled === undefined ? "—" : user.mfaEnabled ? "Enabled" : "Disabled"}
          </p>
        </Card>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-medium text-slate-200">Admin Notes</h3>
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
