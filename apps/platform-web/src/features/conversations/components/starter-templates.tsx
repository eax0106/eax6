import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { ArrowRight, LayoutTemplate } from "lucide-react"
import { queryKeys } from "@/api/query-keys"
import { workflowTemplatesService } from "@/api/services/workflow-templates"
import { cn } from "@/lib/utils"

const GUIDE = [
  "Describe what you want above, or start from one of the templates below.",
  "In the workflow's chat, connect the accounts it needs and adjust its steps and success criteria.",
  "Test it, and activate it only when its results are what you want.",
]

/**
 * D18 / design log §19: the first-run guide and Alter-authored templates shown
 * below the describe box. Choosing one creates a draft workflow and its chat
 * and opens that chat.
 */
export function StarterTemplates() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const templates = useQuery({ queryKey: queryKeys.workflowTemplates.list, queryFn: () => workflowTemplatesService.list() })
  const instantiate = useMutation({
    mutationFn: (templateId: string) => workflowTemplatesService.instantiate(templateId),
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] })
      navigate(`/app/conversations/${result.conversation.id}`)
    },
  })

  if (templates.isError || (templates.data !== undefined && templates.data.length === 0)) return null
  return (
    <section aria-labelledby="starter-templates" className="w-full mt-2">
      <ol aria-label="Getting started" className="mb-6 space-y-1 text-sm text-muted-foreground list-decimal pl-5">
        {GUIDE.map(step => <li key={step}>{step}</li>)}
      </ol>
      <h2 id="starter-templates" className="mb-3 text-sm font-semibold text-foreground">Start from a template</h2>
      {instantiate.isError && <p role="alert" className="mb-3 text-sm text-destructive">{instantiate.error.message}</p>}
      {templates.isPending ? <p className="text-sm text-muted-foreground">Loading templates…</p> : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {templates.data.map(template => (
            <li key={template.template_id}>
              <button
                type="button"
                onClick={() => instantiate.mutate(template.template_id)}
                disabled={instantiate.isPending}
                aria-label={`Use template: ${template.title}`}
                className={cn(
                  "group flex h-full w-full items-start gap-3 p-3 rounded-xl border border-border bg-surface-base text-left transition-all",
                  "hover:border-primary/50 hover:bg-surface-raised",
                  instantiate.isPending && "opacity-50 pointer-events-none",
                )}
              >
                <div className="h-8 w-8 rounded-lg bg-surface-raised flex items-center justify-center shrink-0">
                  <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                </div>
                <span className="flex-1">
                  <span className="block text-sm font-medium">{template.title}</span>
                  <span className="block text-xs text-muted-foreground mt-1">{template.summary}</span>
                </span>
                <ArrowRight className="h-4 w-4 mt-1 text-muted-foreground opacity-0 -translate-x-2 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
