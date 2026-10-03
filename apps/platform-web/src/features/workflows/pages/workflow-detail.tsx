import { useParams, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Play, PenTool, GitCommit, FileCheck } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { formatCurrency } from "@/lib/formatters"
import { StatusBadge } from "@/components/common/status-badge"
import { RequirePermission } from "@/features/permissions/components/require-permission"
import { TriggerList } from "@/features/triggers/components/trigger-list"
import { WorkflowVector } from "@/components/vectors/WorkflowVector"
import { HealthCard } from "./workflow-health"

export function WorkflowDetail() {
  const { workflowId } = useParams()
  const navigate = useNavigate()

  const { data: workflow, isLoading } = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId!),
    queryFn: () => api.getWorkflow(workflowId!),
    enabled: !!workflowId,
  })

  const { data: costEstimate } = useQuery({
    queryKey: queryKeys.costEstimate.workflow(workflowId!),
    queryFn: () => (api as any).costEstimates.forWorkflow(workflowId!),
    enabled: !!workflowId,
  })

  const health = useQuery({
    queryKey: queryKeys.workflowHealth.detail(workflowId!),
    queryFn: () => api.getWorkflowHealth(workflowId!),
    enabled: !!workflowId,
  })

  if (isLoading || !workflow) return null

  return (
    <div className="flex-1 space-y-8 p-8 relative">
      <div className="flex items-center justify-between relative">
        <div className="relative z-10">
          <h1 className="text-3xl font-bold tracking-tight">{workflow.name}</h1>
          <p className="mt-2 text-muted-foreground">{workflow.description || "No description provided."}</p>
        </div>
        <div className="flex items-center gap-3 relative z-10">
          <RequirePermission permission="workflow.update">
            <Button variant="outline" onClick={() => navigate(`/app/workflows/${workflow.id}/versions`)}>
              <GitCommit className="mr-2 h-4 w-4" />
              Versions
            </Button>
            <Button variant="outline" onClick={() => navigate(`/app/workflows/${workflow.id}/build`)}>
              <PenTool className="mr-2 h-4 w-4" />
              Builder
            </Button>
          </RequirePermission>
          <RequirePermission permission="workflow.run">
            <Button variant="primary" onClick={() => navigate(`/app/workflows/${workflow.id}/simulation`)}>
              <Play className="mr-2 h-4 w-4" />
              Simulate
            </Button>
          </RequirePermission>
          <RequirePermission permission="workflow.update">
            <Button variant="primary" onClick={() => navigate(`/app/workflows/${workflow.id}/review`)}>
              <FileCheck className="mr-2 h-4 w-4" />
              Review & Activate
            </Button>
          </RequirePermission>
          <RequirePermission permission="seller.access">
            <Button variant="outline" onClick={() => navigate(`/app/seller/listings/new?workflowId=${workflow.id}`)}>
              Publish Template
            </Button>
          </RequirePermission>
        </div>
        
        {/* Decorative Vector */}
        <div className="hidden lg:block absolute right-0 top-0 w-64 h-24 opacity-80 pointer-events-none">
          <WorkflowVector active={workflow.status === "active"} />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface-raised p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Status</h3>
          <div className="mt-2">
            <StatusBadge status={workflow.status as any} />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface-raised p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Total Runs</h3>
          <p className="mt-2 text-2xl font-semibold">{workflow.runs.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-raised p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Success Rate</h3>
          <p className="mt-2 text-2xl font-semibold">{workflow.successRate}%</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-raised p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Est. Cost / Run</h3>
          <p className="mt-2 text-2xl font-semibold">
            {costEstimate ? formatCurrency(costEstimate.expected, costEstimate.currency) : "-"}
          </p>
        </div>
      </div>

      <section aria-label="Workflow health" className="space-y-3">
        <h2 className="text-xl font-semibold">Workflow health</h2>
        {health.isLoading && <p>Loading workflow health…</p>}
        {health.isError && <div role="alert">Failed to load workflow health. <Button onClick={() => health.refetch()}>Try Again</Button></div>}
        {health.data && <HealthCard health={health.data} />}
      </section>

      <div className="mt-8 border-t border-border pt-8">
        <TriggerList workflowId={workflow.id} />
      </div>
    </div>
  )
}
