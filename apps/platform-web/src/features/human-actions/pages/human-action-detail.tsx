
import { useParams, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { ErrorState } from "@/components/feedback/error-state"
import { ArrowLeft, Clock, Activity, FileText } from "lucide-react"
import { ApprovalPolicySection } from "../components/approval-policy-section"
import { DecisionPanel } from "../components/decision-panel"
import { ContextPanel } from "../components/context-panel"
import { ActivityTimeline } from "../components/activity-timeline"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

export function HumanActionDetail() {
  const { actionId } = useParams()
  const navigate = useNavigate()

  const { data: action, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.humanActions.detail(actionId!),
    queryFn: () => (api as any).getHumanAction(actionId!)
  })

  if (isLoading) {
    return (
      <div className="flex h-full flex-col p-8 space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-surface-hover" />
        <div className="h-64 animate-pulse rounded-xl bg-surface-hover" />
      </div>
    )
  }

  if (isError || !action) {
    return (
      <div className="flex h-full flex-col p-8">
        <Button variant="ghost" className="mb-4 self-start" onClick={() => navigate("/app/human-actions")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Queue
        </Button>
        <ErrorState 
          title="Action not found"
          description="The human action could not be loaded."
          retryAction={<Button onClick={() => refetch()}>Try Again</Button>}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-surface px-8 py-4">
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 text-text-muted hover:text-text-primary" onClick={() => navigate("/app/human-actions")}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Actions
        </Button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{action.title}</h1>
            <div className="mt-1 flex items-center gap-4 text-sm text-text-muted">
              <span>{action.workflowName || action.projectName || "System"}</span>
              <span className="flex items-center">
                <Clock className="mr-1 h-3 w-3" />
                Created {new Date(action.createdAt).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="mx-auto max-w-5xl grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            {action.description && (
              <p className="text-text-secondary">{action.description}</p>
            )}

            <Tabs defaultValue="context">
              <TabsList className="mb-4">
                <TabsTrigger value="context" className="gap-2">
                  <FileText className="h-4 w-4" /> Context & Data
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-2">
                  <Activity className="h-4 w-4" /> Activity & Notes
                </TabsTrigger>
              </TabsList>
              <TabsContent value="context" className="mt-0">
                <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
                  <ContextPanel action={action} />
                </div>
              </TabsContent>
              <TabsContent value="activity" className="mt-0">
                <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
                  <ActivityTimeline action={action} />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div className="lg:col-span-1 space-y-6">
            <DecisionPanel action={action} />
            <ApprovalPolicySection action={action} />
          </div>
        </div>
      </div>
    </div>
  )
}
