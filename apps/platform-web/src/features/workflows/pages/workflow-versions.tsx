import * as React from "react"
import { useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { FlaskConical, GitCommit, Loader2, RotateCcw, Rocket, Split } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { StatusBadge } from "@/components/common/status-badge"
import { toast } from "sonner"
import type { WorkflowVersion } from "@/api/types"

/**
 * The Deployment Manager (C8). Every version and status here comes from the
 * workflow's own compiled versions, and the three actions are the lifecycle
 * contract's own: promote a tested version, run one as a canary on a share
 * of traffic, or roll the promoted one back. A compiled version is tested
 * first, because nothing else can be done to it until it has been.
 */
export function WorkflowVersions() {
  const { workflowId } = useParams()
  const queryClient = useQueryClient()
  const [canaryFor, setCanaryFor] = React.useState<string | undefined>(undefined)
  const [trafficPercent, setTrafficPercent] = React.useState("10")

  const { data: workflow } = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId!),
    queryFn: () => api.getWorkflow(workflowId!),
    enabled: !!workflowId,
  })

  const {
    data: versions,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: queryKeys.workflows.versions(workflowId!),
    queryFn: () => api.getWorkflowVersions(workflowId!),
    enabled: !!workflowId,
  })

  function afterAction(message: string) {
    return () => {
      toast.success(message)
      setCanaryFor(undefined)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.versions(workflowId!) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflowId!) })
    }
  }

  // The engine refuses a transition its state machine does not allow, and
  // says why; showing that beats guessing at what went wrong.
  function onError(fallback: string) {
    return (actionError: unknown) => {
      toast.error(actionError instanceof Error ? actionError.message : fallback)
    }
  }

  // A compiled version has to be tested before it can be deployed at all:
  // the release gate behind this decides whether it becomes "tested".
  const test = useMutation({
    mutationFn: (versionId: string) => api.testWorkflowVersion(workflowId!, versionId),
    onSuccess: afterAction("Version tested."),
    onError: onError("Could not test this version"),
  })

  const promote = useMutation({
    mutationFn: (versionId: string) => api.promoteWorkflowVersion(workflowId!, versionId),
    onSuccess: afterAction("Version promoted."),
    onError: onError("Could not promote this version"),
  })

  const canary = useMutation({
    mutationFn: (variables: { versionId: string; percent: number }) =>
      api.startWorkflowVersionCanary(workflowId!, variables.versionId, variables.percent),
    onSuccess: afterAction("Canary started."),
    onError: onError("Could not start a canary for this version"),
  })

  const rollback = useMutation({
    mutationFn: (versionId: string) => api.rollbackWorkflowVersion(workflowId!, versionId),
    onSuccess: afterAction("Rolled back."),
    onError: onError("Could not roll back to this version"),
  })

  const busy =
    test.isPending || promote.isPending || canary.isPending || rollback.isPending

  return (
    <div className="flex-1 space-y-8 p-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Version History</h1>
        <p className="mt-2 text-muted-foreground">{workflow?.name ?? "Workflow"}</p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Loading versions…
        </div>
      )}

      {isError && (
        <div className="rounded-xl border border-border bg-surface-raised p-6 text-sm">
          <p className="font-medium">Could not load this workflow&rsquo;s versions.</p>
          <p className="mt-1 text-muted-foreground">
            {error instanceof Error ? error.message : "The request failed."}
          </p>
        </div>
      )}

      {versions?.length === 0 && !isLoading && (
        <div className="rounded-xl border border-border bg-surface-raised p-6">
          <p className="font-medium">No versions yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A version is created when this workflow is compiled.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {versions?.map((version, index) => (
          <div
            key={version.id}
            className="flex gap-4 rounded-xl border border-border bg-surface-raised p-6"
          >
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                <GitCommit className="h-4 w-4" />
              </div>
              {index !== versions.length - 1 && <div className="h-full w-px bg-border" />}
            </div>
            <div className="flex-1 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold flex items-center gap-2">
                    Version {version.version}
                    <StatusBadge status={version.status} />
                    {version.status === "canary" && version.trafficPercent !== null && (
                      <span className="text-xs text-muted-foreground">
                        {version.trafficPercent}% of traffic
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    DAG schema {version.dagSchemaVersion}
                    {version.testedAt ? " · tested" : ""}
                    {version.evaluationFailedAt ? " · evaluation failed" : ""}
                  </p>
                </div>
                <p className="text-sm text-foreground/90 whitespace-nowrap">
                  {formatDistanceToNow(new Date(version.createdAt), { addSuffix: true })}
                </p>
              </div>

              <VersionActions
                version={version}
                busy={busy}
                canaryOpen={canaryFor === version.id}
                trafficPercent={trafficPercent}
                onTrafficPercentChange={setTrafficPercent}
                onTest={() => test.mutate(version.id)}
                onPromote={() => promote.mutate(version.id)}
                onOpenCanary={() => setCanaryFor(version.id)}
                onCancelCanary={() => setCanaryFor(undefined)}
                onStartCanary={() =>
                  canary.mutate({ versionId: version.id, percent: Number(trafficPercent) })
                }
                onRollback={() => rollback.mutate(version.id)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface VersionActionsProps {
  version: WorkflowVersion
  busy: boolean
  canaryOpen: boolean
  trafficPercent: string
  onTrafficPercentChange: (value: string) => void
  onTest: () => void
  onPromote: () => void
  onOpenCanary: () => void
  onCancelCanary: () => void
  onStartCanary: () => void
  onRollback: () => void
}

/**
 * Only the transitions the lifecycle service allows are offered: a version
 * is tested first, then promoted or sent out as a canary, and only a
 * promoted version can be rolled back.
 */
function VersionActions({
  version,
  busy,
  canaryOpen,
  trafficPercent,
  onTrafficPercentChange,
  onTest,
  onPromote,
  onOpenCanary,
  onCancelCanary,
  onStartCanary,
  onRollback,
}: VersionActionsProps) {
  const percent = Number(trafficPercent)
  const percentValid = Number.isInteger(percent) && percent >= 1 && percent <= 99

  if (canaryOpen) {
    return (
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <label className="text-sm text-muted-foreground" htmlFor={`traffic-${version.id}`}>
          Traffic share
        </label>
        <Input
          id={`traffic-${version.id}`}
          className="w-24"
          value={trafficPercent}
          onChange={(event) => onTrafficPercentChange(event.target.value)}
          disabled={busy}
        />
        <span className="text-sm text-muted-foreground">% (1&ndash;99)</span>
        <Button size="sm" onClick={onStartCanary} disabled={busy || !percentValid}>
          Start canary
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancelCanary} disabled={busy}>
          Cancel
        </Button>
      </div>
    )
  }

  if (version.status === "compiled") {
    return (
      <div className="flex flex-wrap gap-2 pt-2">
        <Button size="sm" onClick={onTest} disabled={busy}>
          <FlaskConical className="mr-2 h-4 w-4" />
          Test
        </Button>
      </div>
    )
  }

  if (version.status === "tested") {
    return (
      <div className="flex flex-wrap gap-2 pt-2">
        <Button size="sm" onClick={onPromote} disabled={busy}>
          <Rocket className="mr-2 h-4 w-4" />
          Promote
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenCanary} disabled={busy}>
          <Split className="mr-2 h-4 w-4" />
          Start canary
        </Button>
      </div>
    )
  }

  if (version.status === "promoted") {
    return (
      <div className="flex flex-wrap gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={onRollback} disabled={busy}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Roll back
        </Button>
      </div>
    )
  }

  return null
}
