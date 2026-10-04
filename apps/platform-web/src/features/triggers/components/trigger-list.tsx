import { useState } from "react"
import { HostedFormSetupPanel } from "./hosted-form-setup"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Play, Webhook, Clock, Zap, Settings, CheckCircle2, AlertCircle, Mail, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface TriggerListProps {
  workflowId: string
}

export function TriggerList({ workflowId }: TriggerListProps) {
  const queryClient = useQueryClient()
  const [setup, setSetup] = useState<{ triggerId?: string } | null>(null)
  
  const { data: triggers, isLoading } = useQuery({
    queryKey: queryKeys.triggers.list(workflowId),
    queryFn: () => api.getTriggers(workflowId),
  })

  const toggleTrigger = useMutation({
    mutationFn: async ({ id, enable }: { id: string, enable: boolean }) => {
      if (triggers?.find(t => t.id === id)?.provider === "alter_public_form") {
        const current = await api.getHostedForm(id)
        return api.setHostedFormStatus(id, enable ? "enabled" : "disabled", current.etag)
      }
      return enable ? api.enableTrigger(id) : api.disableTrigger(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triggers.list(workflowId) })
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triggers.list(workflowId) })
      toast.error(error instanceof Error ? error.message : "Could not change trigger status")
    },
  })

  const testTrigger = useMutation({
    mutationFn: (id: string) => api.testTrigger(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triggers.list(workflowId) })
      if (data.success) toast.success(data.message)
      else toast.error(data.message)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not test trigger"),
  })

  const removeTrigger = useMutation({
    mutationFn: async (id: string) => {
      if (triggers?.find(t => t.id === id)?.provider === "alter_public_form") {
        const current = await api.getHostedForm(id)
        await api.setHostedFormStatus(id, "archived", current.etag)
      } else await api.removeTrigger(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triggers.list(workflowId) })
      toast.success("Trigger removed")
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triggers.list(workflowId) })
      toast.error(error instanceof Error ? error.message : "Could not remove trigger")
    },
  })

  if (isLoading) return <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>

  const setupPanel = setup && <HostedFormSetupPanel workflowId={workflowId} {...setup} onClose={() => setSetup(null)} />

  if (!triggers?.length) {
    return (
      <div>{setupPanel}<div className="text-center p-8 border border-border border-dashed rounded-xl bg-surface-base">
        <Zap className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-foreground">No triggers configured.</p>
        <p className="text-sm text-muted-foreground mt-1">Add a trigger to start this workflow automatically.</p>
        <Button variant="outline" className="mt-4" onClick={() => setSetup({})}>Add Trigger</Button>
      </div></div>
    )
  }

  const getIcon = (type: string) => {
    switch(type) {
      case "webhook": return <Webhook className="h-4 w-4" />
      case "schedule": return <Clock className="h-4 w-4" />
      case "email": return <Mail className="h-4 w-4" />
      default: return <Zap className="h-4 w-4" />
    }
  }

  return (
    <div className="space-y-4">
      {setupPanel}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Configured Triggers</h3>
        <Button variant="outline" size="sm" onClick={() => setSetup({})}>Add Trigger</Button>
      </div>

      <div className="grid gap-3">
        {triggers.map(t => (
          <div key={t.id} className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface-base">
            <div className="flex items-center gap-4">
              <div className={cn(
                "h-10 w-10 shrink-0 rounded-lg flex items-center justify-center",
                t.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}>
                {getIcon(t.type)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="font-medium text-sm">{t.name}</h4>
                  {t.status === "configured" && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                  {t.status === "needs_configuration" && <AlertCircle className="h-3 w-3 text-amber-500" />}
                  {t.status === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
                </div>
                <p className="text-xs text-muted-foreground capitalize mt-0.5">{t.type} Trigger</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => testTrigger.mutate(t.id)}
                disabled={t.provider === "alter_public_form" || testTrigger.isPending || t.status === "needs_configuration"}
              >
                <Play className="h-4 w-4 mr-2" />
                Test
              </Button>
              <Button variant="ghost" size="icon" aria-label={`Settings for ${t.name}`} disabled={t.provider !== "alter_public_form"} onClick={() => setSetup({ triggerId: t.id })}>
                <Settings className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Remove trigger"
                aria-label={`Remove ${t.name}`}
                onClick={() => {
                  if (window.confirm(`Remove '${t.name}'? This archives the trigger.`)) {
                    removeTrigger.mutate(t.id)
                  }
                }}
                disabled={removeTrigger.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Button 
                variant={t.enabled ? "primary" : "outline"}
                size="sm"
                onClick={() => toggleTrigger.mutate({ id: t.id, enable: !t.enabled })}
                disabled={t.status === "needs_configuration" || toggleTrigger.isPending}
              >
                {t.enabled ? "Enabled" : "Disabled"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
