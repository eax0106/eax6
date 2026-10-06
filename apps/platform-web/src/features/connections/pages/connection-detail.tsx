import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { ArrowLeft, RefreshCw, Trash2, Key, Link as LinkIcon, AlertTriangle } from "lucide-react"

import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"

export function ConnectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: connection, isLoading: loadingConn } = useQuery({
    queryKey: queryKeys.connections.detail(id!),
    queryFn: () => api.getConnection(id!),
    enabled: !!id
  })

  const { data: integration, isLoading: loadingInt } = useQuery({
    queryKey: queryKeys.integrations.detail(connection?.integrationId || ""),
    queryFn: () => api.getIntegration(connection!.integrationId),
    enabled: !!connection
  })

  const { data: credential } = useQuery({
    queryKey: queryKeys.credentials.detail(connection?.credentialId || ""),
    queryFn: () => api.getCredential(connection!.credentialId!),
    enabled: !!connection?.credentialId
  })

  const testMutation = useMutation({
    mutationFn: () => api.testConnection(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.detail(id!) })
    }
  })

  const reconnectMutation = useMutation({ mutationFn: () => api.reconnectConnection(id!),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.connections.detail(id!) }) } })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteConnection(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.list })
      navigate("/app/connections")
    }
  })

  if (loadingConn || loadingInt || !connection || !integration) {
    return <div className="p-8 text-muted-foreground">Loading connection...</div>
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <Button variant="ghost" onClick={() => navigate("/app/connections")} className="mb-4">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to Catalog
      </Button>

      <PageHeader 
        title={connection.name}
        description={`Integration with ${integration.name}. Created ${formatDistanceToNow(new Date(connection.createdAt), { addSuffix: true })}`}
        primaryAction={
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={() => testMutation.mutate()} 
              disabled={testMutation.isPending}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${testMutation.isPending ? 'animate-spin' : ''}`} />
              Test Connection
            </Button>
            <Button variant="outline" onClick={() => reconnectMutation.mutate()} disabled={reconnectMutation.isPending || !integration.available}>
              {reconnectMutation.isPending ? "Opening authorization…" : "Reconnect"}
            </Button>
            <Button 
              variant="danger" 
              onClick={() => {
                if (window.confirm("Are you sure you want to delete this connection? Workflows relying on it may fail.")) {
                  deleteMutation.mutate()
                }
              }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        }
      />

      {reconnectMutation.isError && <p role="alert" className="mt-4 text-destructive">Reconnect failed. Try again with the original provider account.</p>}

      {testMutation.isSuccess && (
        <div className={`mt-4 p-4 border rounded-md mb-6 ${testMutation.data.success ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-destructive/10 border-destructive/20 text-destructive'}`}>
          {testMutation.data.message}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Details about the connected service</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 text-sm">
              <span className="text-muted-foreground font-medium">Service</span>
              <span className="col-span-2 flex items-center gap-2">
                <LinkIcon className="h-4 w-4 text-muted-foreground" />
                {integration.name} ({integration.category})
              </span>
            </div>
            <div className="grid grid-cols-3 text-sm">
              <span className="text-muted-foreground font-medium">Auth Type</span>
              <span className="col-span-2 capitalize">{integration.authType.replace('_', ' ')}</span>
            </div>
            <div className="grid grid-cols-3 text-sm">
              <span className="text-muted-foreground font-medium">Capabilities</span>
              <span className="col-span-2">
                {integration.capabilities.join(", ")}
              </span>
            </div>
            <div className="grid grid-cols-3 text-sm">
              <span className="text-muted-foreground font-medium">Last Checked</span>
              <span className="col-span-2">
                {connection.lastCheckedAt ? formatDistanceToNow(new Date(connection.lastCheckedAt), { addSuffix: true }) : "Never"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Linked Credential</CardTitle>
            <CardDescription>The secret or token used to authenticate</CardDescription>
          </CardHeader>
          <CardContent>
            {credential ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-md border">
                  <Key className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-medium text-sm">{credential.name}</div>
                    <div className="text-xs text-muted-foreground">Type: {credential.type}</div>
                  </div>
                </div>
                {connection.status === "error" || connection.status === "expired" ? (
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>The credential may be expired or invalid. Please update it in the Credentials Vault.</span>
                  </div>
                ) : null}
                <Button variant="outline" className="w-full" onClick={() => navigate("/app/settings/credentials")}>
                  Manage in Vault
                </Button>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic p-4 text-center border rounded-md border-dashed">
                No credential linked or connection doesn't require one.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
