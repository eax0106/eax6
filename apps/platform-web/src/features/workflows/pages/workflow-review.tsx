import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation } from "@tanstack/react-query"
import { Play, FileCheck, AlertTriangle, CheckCircle2 } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { formatMinorCurrency } from "@/lib/formatters"
import { SafeguardsSection } from "../components/safeguards-section"
import { toast } from "sonner"

function integrationIdFromCredentialReference(reference: unknown): string | undefined {
  if (typeof reference !== "string") return undefined
  const segments = reference.split("/")
  return segments.length === 8 && segments[5] === "integration" ? segments[6] : undefined
}

export function WorkflowReview() {
  const { workflowId } = useParams()
  const navigate = useNavigate()

  const { data: workflow, isLoading } = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId!),
    queryFn: () => api.getWorkflow(workflowId!),
    enabled: !!workflowId,
  })

  const { data: triggers, isLoading: triggersLoading, isError: triggersError } = useQuery({
    queryKey: queryKeys.triggers.list(workflowId!),
    queryFn: () => api.getTriggers(workflowId!),
    enabled: !!workflowId,
  })

  const toolNodes = workflow?.dag?.nodes.filter((node) => node.type === "ToolCall") ?? []
  const requiredIntegrationIds = [
    ...new Set(
      toolNodes
        .map((node) => integrationIdFromCredentialReference(node.config.credential_ref))
        .filter((id): id is string => id !== undefined),
    ),
  ]
  const {
    data: connections,
    isLoading: connectionsLoading,
    isError: connectionsError,
  } = useQuery({
    queryKey: queryKeys.connections.list,
    queryFn: () => api.getConnections(),
    enabled: toolNodes.length > 0,
  })

  const { data: estimate, isLoading: estimateLoading, isError: estimateError } = useQuery({
    queryKey: queryKeys.workflows.estimate(workflowId!),
    queryFn: () => api.getRunEstimate(workflowId!),
    enabled: !!workflowId,
  })

  const activateMutation = useMutation({
    mutationFn: () => api.activateWorkflow(workflowId!),
    onSuccess: () => {
      toast.success("Workflow activated successfully")
      navigate(`/app/workflows/${workflowId}`)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not activate workflow")
    },
  })

  if (isLoading || !workflow) return null

  const hasCompiledGraph = Boolean(workflow.dag?.nodes.length)
  const configuredTriggers = triggers?.filter((trigger) => trigger.status === "configured") ?? []
  const enabledTriggers = configuredTriggers.filter((trigger) => trigger.enabled)
  const triggersNeedingAttention = triggers?.filter((trigger) => trigger.status !== "configured") ?? []
  const matchedConnections = requiredIntegrationIds.map((integrationId) =>
    connections?.find(
      (connection) => connection.id === integrationId || connection.integrationId === integrationId,
    ),
  )
  const unmatchedConnectionCount = matchedConnections.filter((connection) => !connection).length
  const unhealthyConnections = matchedConnections.filter(
    (connection) => connection && connection.status !== "connected",
  )
  const hasMissingCredentialReferences = toolNodes.some(
    (node) => integrationIdFromCredentialReference(node.config.credential_ref) === undefined,
  )

  // D4: shown before any run starts. Billed price only (D24).
  let costSummary = "Loading…"
  if (estimateError) costSummary = "Unavailable"
  else if (estimate) {
    const atMost = `at most ${formatMinorCurrency(String(estimate.atMostMinor), "INR")}`
    costSummary =
      estimate.usuallyMinor === null
        ? atMost
        : `usually ${formatMinorCurrency(String(estimate.usuallyMinor), "INR")} (last ${estimate.sampleRuns} runs), ${atMost}`
  } else if (!estimateLoading) costSummary = "Unavailable"

  let triggerSummary = "Manual only"
  if (triggersLoading) triggerSummary = "Loading…"
  else if (triggersError) triggerSummary = "Unavailable"
  else if (triggers?.length === 1) triggerSummary = triggers[0]!.name
  else if (triggers && triggers.length > 1) triggerSummary = `${triggers.length} triggers`

  let connectionReadiness: { title: string; description: string; ready: boolean } = {
    title: "No connections required",
    description: "This workflow has no tool-call nodes.",
    ready: true,
  }
  if (toolNodes.length > 0) {
    if (connectionsLoading) {
      connectionReadiness = {
        title: "Checking connection status",
        description: "Loading the workspace connections used by this workflow.",
        ready: false,
      }
    } else if (
      connectionsError ||
      hasMissingCredentialReferences ||
      unmatchedConnectionCount > 0
    ) {
      connectionReadiness = {
        title: "Connection status unverified",
        description:
          "At least one tool connection could not be matched to a live workspace connection. Verify integrations before activation.",
        ready: false,
      }
    } else if (unhealthyConnections.length > 0) {
      connectionReadiness = {
        title: "Connection needs attention",
        description: `${unhealthyConnections.length} required ${unhealthyConnections.length === 1 ? "connection is" : "connections are"} not healthy.`,
        ready: false,
      }
    } else {
      connectionReadiness = {
        title: "Connections ready",
        description: `${matchedConnections.length} required ${matchedConnections.length === 1 ? "connection is" : "connections are"} connected.`,
        ready: true,
      }
    }
  }

  return (
    <div className="flex-1 space-y-8 p-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Review & Activate</h1>
        <p className="mt-2 text-muted-foreground">Review the configuration before activating this workflow.</p>
      </div>

      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-surface-raised overflow-hidden">
          <div className="border-b border-border bg-surface px-4 py-3 font-medium">
            Workflow Summary
          </div>
          <div className="p-6 space-y-4">
            <div className="flex justify-between border-b border-border pb-4">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium">{workflow.name}</span>
            </div>
            <div className="flex justify-between border-b border-border pb-4">
              <span className="text-muted-foreground">Trigger</span>
              <span className="font-medium">{triggerSummary}</span>
            </div>
            <div className="flex justify-between border-b border-border pb-4">
              <span className="text-muted-foreground">Cost per run</span>
              <span className="text-right">
                <span className="font-medium">{costSummary}</span>
                {estimate && estimate.unpricedCalls > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    {estimate.unpricedCalls} {estimate.unpricedCalls === 1 ? "step has" : "steps have"} no price on record yet, so the real cost can be higher.
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex justify-between border-b border-border pb-4">
              <span className="text-muted-foreground">Nodes</span>
              <span className="font-medium">
                {workflow.dag ? `${workflow.dag.nodes.length} ${workflow.dag.nodes.length === 1 ? "node" : "nodes"}` : "Unavailable"}
              </span>
            </div>
          </div>
        </div>

        <SafeguardsSection workflowId={workflowId!} />

        <div className="rounded-xl border border-border bg-surface-raised overflow-hidden">
          <div className="border-b border-border bg-surface px-4 py-3 font-medium">
            Readiness Checklist
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-3">
              {hasCompiledGraph ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
              )}
              <div>
                <p className="font-medium">
                  {hasCompiledGraph ? "Compiled workflow graph" : "Workflow graph unavailable"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {hasCompiledGraph
                    ? `${workflow.dag!.nodes.length} ${workflow.dag!.nodes.length === 1 ? "node is" : "nodes are"} available for activation.`
                    : "Compile the workflow before activating it."}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {!triggersLoading && !triggersError && triggersNeedingAttention.length === 0 ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
              )}
              <div>
                <p className="font-medium">
                  {triggersLoading
                    ? "Checking trigger status"
                    : triggersError
                      ? "Trigger status unavailable"
                      : triggersNeedingAttention.length > 0
                        ? "Trigger needs attention"
                        : enabledTriggers.length > 0
                          ? "Automatic start configured"
                          : "Manual start available"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {triggersLoading
                    ? "Loading this workflow's triggers."
                    : triggersError
                      ? "Trigger readiness could not be loaded. The workflow can still be started manually."
                      : triggersNeedingAttention.length > 0
                        ? `${triggersNeedingAttention.length} ${triggersNeedingAttention.length === 1 ? "trigger needs" : "triggers need"} configuration.`
                        : enabledTriggers.length > 0
                          ? `${enabledTriggers.length} enabled ${enabledTriggers.length === 1 ? "trigger is" : "triggers are"} ready.`
                          : "No enabled automatic triggers. The workflow can still be started manually."}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {connectionReadiness.ready ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
              )}
              <div>
                <p className="font-medium">{connectionReadiness.title}</p>
                <p className="text-sm text-muted-foreground">{connectionReadiness.description}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-6 border-t border-border">
        <Button variant="outline" onClick={() => navigate(`/app/workflows/${workflowId}/simulation`)}>
          <Play className="mr-2 h-4 w-4" />
          Simulate
        </Button>
        <Button 
          variant="primary" 
          onClick={() => activateMutation.mutate()}
          disabled={activateMutation.isPending || !hasCompiledGraph}
        >
          <FileCheck className="mr-2 h-4 w-4" />
          Activate Workflow
        </Button>
      </div>
    </div>
  )
}
