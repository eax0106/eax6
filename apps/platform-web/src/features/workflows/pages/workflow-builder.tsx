import * as React from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Save, Play, LayoutTemplate, PanelRight, ChevronLeft } from "lucide-react"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { compileDag, dagToCanvas, WorkflowGraphCycleError } from "@/api/compile-dag"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { WorkflowCanvas } from "../components/builder/canvas"
import { NodePalette } from "../components/builder/node-palette"
import { Inspector } from "../components/builder/inspector"
import { ValidationPanel } from "../components/builder/validation-panel"
import { useBuilderStore } from "../stores/useBuilderStore"

export function WorkflowBuilder() {
  const { workflowId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { setWorkflowId, nodes, edges, successCriteria, setSuccessCriteria, setNodes, setEdges, isDirty, setDirty, inspectorOpen, setInspectorOpen } = useBuilderStore()
  const [askGoal, setAskGoal] = React.useState(false)

  React.useEffect(() => {
    if (workflowId) setWorkflowId(workflowId)
  }, [workflowId, setWorkflowId])

  const { data: workflow, isLoading } = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId!),
    queryFn: () => api.getWorkflow(workflowId!),
    enabled: !!workflowId,
  })

  // Load the canvas from the workflow's compiled DAG. Mock mode has no
  // real DAG to load, so it keeps showing a fixed demo graph instead.
  React.useEffect(() => {
    if (!workflow || isDirty) return
    if (!isLiveApi) {
      const mockNodes = [
        { id: "1", type: "trigger_webhook", position: { x: 250, y: 50 }, data: { label: "Incoming Webhook", category: "Triggers" } },
        { id: "2", type: "ai_extract", position: { x: 250, y: 200 }, data: { label: "Extract Lead Info", category: "AI" } },
        { id: "3", type: "action_slack", position: { x: 250, y: 350 }, data: { label: "Slack Notification", category: "Actions" } }
      ]
      const mockEdges = [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" }
      ]
      setNodes(mockNodes)
      setEdges(mockEdges)
    } else if (workflow.dag) {
      const { nodes: loadedNodes, edges: loadedEdges } = dagToCanvas(workflow.dag)
      setNodes(loadedNodes)
      setEdges(loadedEdges)
      setSuccessCriteria(workflow.dag.success_criteria)
    }
    setDirty(false)
  }, [workflow, isDirty, setNodes, setEdges, setDirty, setSuccessCriteria])

  const saveMutation = useMutation({
    mutationFn: (graph: Parameters<typeof api.saveWorkflowGraph>[1]) => api.saveWorkflowGraph(workflowId!, graph),
    onSuccess: (_result, graph) => {
      queryClient.setQueryData(queryKeys.workflows.detail(workflowId!), { ...workflow, dag: compileDag(graph.nodes, graph.edges, graph.successCriteria) })
      const current = useBuilderStore.getState()
      if (current.nodes === graph.nodes && current.edges === graph.edges && current.successCriteria === graph.successCriteria) setDirty(false)
      setAskGoal(false)
      toast.success("Workflow saved")
    },
    onError: (error) => {
      toast.error(
        error instanceof WorkflowGraphCycleError
          ? error.message
          : "Workflow could not be saved",
      )
    },
  })

  const save = () => {
    if (isLiveApi && workflow?.dag && (workflow.status === "active" || workflow.status === "paused")
      && (workflow.dag.success_criteria?.length || workflow.dag.nodes.some(node => node.success_criteria?.length))) {
      const original = dagToCanvas(workflow.dag)
      const meaningful = (graph: ReturnType<typeof compileDag>) => JSON.stringify({
        nodes: graph.nodes.map(({ key, type, config, success_criteria }) => ({ key, type, config, success_criteria })),
        edges: graph.edges,
        success_criteria: graph.success_criteria,
      })
      try {
        if (meaningful(compileDag(nodes, edges, successCriteria)) !== meaningful(compileDag(original.nodes, original.edges, workflow.dag.success_criteria))) {
          setAskGoal(true); return
        }
      } catch (error) { toast.error(error instanceof Error ? error.message : "Workflow could not be saved"); return }
    }
    saveMutation.mutate({ nodes, edges, successCriteria })
  }

  const handleAutoLayout = () => {
    if ((window as any).applyAutoLayout) {
      (window as any).applyAutoLayout()
    }
  }

  if (isLoading) return null

  return (
    <div className="flex h-screen flex-col bg-surface overflow-hidden">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/app/workflows/${workflowId}`)}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-sm font-semibold">{workflow?.name || "Workflow Builder"}</h1>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{isDirty ? "Unsaved changes" : "Saved"}</span>
              <span className="text-xs text-muted-foreground">•</span>
              <span className="text-xs text-muted-foreground capitalize">{workflow?.status}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleAutoLayout}>
            <LayoutTemplate className="mr-2 h-4 w-4" />
            Auto layout
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setInspectorOpen(!inspectorOpen)} className={inspectorOpen ? "bg-surface-hover" : ""}>
            <PanelRight className="mr-2 h-4 w-4" />
            Inspector
          </Button>
          <div className="h-4 w-px bg-border mx-2" />
          <Button variant="outline" size="sm" onClick={save} disabled={!isDirty || saveMutation.isPending}>
            <Save className="mr-2 h-4 w-4" />
            Save
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate(`/app/workflows/${workflowId}/simulation`)}>
            <Play className="mr-2 h-4 w-4" />
            Simulate
          </Button>
        </div>
      </header>

      {askGoal && <div role="alertdialog" aria-labelledby="goal-change-title" className="space-y-3 border-b border-border p-4">
        <h2 id="goal-change-title" className="font-medium">Did this edit change the workflow goal?</h2>
        <p>This edit affects steps used to verify success. Keep the existing criteria or review a new plan before building.</p>
        <div className="flex gap-2">
          <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate({ nodes, edges, successCriteria })}>Goal unchanged — save</Button>
          <Button disabled={saveMutation.isPending} onClick={() => navigate(`/app/conversations/cnv_${workflowId!.slice(3)}`)}>Goal changed — review plan</Button>
          <Button variant="outline" disabled={saveMutation.isPending} onClick={() => setAskGoal(false)}>Cancel</Button>
        </div>
      </div>}

      {/* Main Builder Area */}
      <div className="flex flex-1 overflow-hidden">
        <NodePalette />
        <div className="relative flex-1">
          <WorkflowCanvas />
          <ValidationPanel />
        </div>
        {inspectorOpen && <Inspector />}
      </div>
    </div>
  )
}
