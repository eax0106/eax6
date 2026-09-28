import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles } from "lucide-react"

/** Suggestions derived from this workspace's own activity (task B3.3, live mode). */
export function WorkspaceSuggestions() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const suggestions = useQuery({ queryKey: queryKeys.discovery.suggestions, queryFn: () => api.discovery.listSuggestions() })
  const accept = useMutation({
    mutationFn: (id: string) => api.discovery.acceptSuggestion(id),
    onSuccess: (workflowId) => navigate(`/app/workflows/${encodeURIComponent(workflowId)}`),
  })
  const dismiss = useMutation({
    mutationFn: (id: string) => api.discovery.dismissSuggestion(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.discovery.suggestions }),
  })
  const error = (suggestions.error ?? accept.error ?? dismiss.error) as Error | null

  return (
    <section>
      <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
        <Sparkles className="h-5 w-5 text-primary" />
        Suggested for this workspace
      </h2>
      {error && <p role="alert" className="text-sm text-destructive mb-3">{error.message}</p>}
      {suggestions.isLoading ? (
        <p className="text-sm text-text-muted">Looking at recent activity...</p>
      ) : !suggestions.data?.length ? (
        <p className="text-sm text-text-muted">No suggestions yet. They appear as this workspace runs workflows, adds documents and connects tools.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {suggestions.data.map((s) => (
            <div key={s.id} className="flex flex-col rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant={s.riskLevel === "high" ? "danger" : s.riskLevel === "medium" ? "warning" : "success"}>{s.riskLevel} risk</Badge>
                <span className="text-xs text-text-muted">{Math.round(s.confidence * 100)}% confidence</span>
              </div>
              <p className="text-sm text-text-primary flex-1 mb-3">{s.problemStatement}</p>
              {s.requiredIntegrations.length > 0 && (
                <p className="text-xs text-text-muted mb-4">Uses: {s.requiredIntegrations.join(", ")}</p>
              )}
              <div className="flex gap-2">
                <Button className="flex-1" disabled={accept.isPending} onClick={() => accept.mutate(s.id)}>Create draft workflow</Button>
                <Button variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate(s.id)}>Dismiss</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
