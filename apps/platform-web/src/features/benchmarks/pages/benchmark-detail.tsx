import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { ArrowLeft, Play } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LoadingState } from "@/components/feedback/loading-state"
import { ErrorState } from "@/components/feedback/error-state"
import { PermissionGate } from "@/features/permissions/components/permission-gate"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import type { BenchmarkRun } from "@/api/services/benchmarks"
import { costLabel, passRateLabel } from "../run-format"

const unfinished = (status: BenchmarkRun["status"]) => status === "pending" || status === "running"

export function BenchmarkDetailPage() {
  const { benchmarkId = "" } = useParams<{ benchmarkId: string }>()
  const queryClient = useQueryClient()
  const [workflowId, setWorkflowId] = useState("")
  const [selectedRun, setSelectedRun] = useState<string | undefined>()

  const dataset = useQuery({ queryKey: queryKeys.benchmarks.dataset(benchmarkId), queryFn: () => api.benchmarks.getDataset(benchmarkId) })
  const runs = useQuery({
    queryKey: queryKeys.benchmarks.runs(benchmarkId),
    queryFn: () => api.benchmarks.listRuns(benchmarkId),
    refetchInterval: query => (query.state.data ?? []).some(run => unfinished(run.status)) ? 3000 : false,
  })
  const workflows = useQuery({ queryKey: queryKeys.workflows.all, queryFn: () => api.getWorkflows() })
  const runId = selectedRun ?? runs.data?.[0]?.id
  const run = useQuery({
    queryKey: queryKeys.benchmarks.run(runId ?? ""),
    queryFn: () => api.benchmarks.getRun(runId!),
    enabled: runId !== undefined,
    refetchInterval: query => query.state.data && unfinished(query.state.data.status) ? 3000 : false,
  })

  const start = useMutation({
    mutationFn: () => api.benchmarks.startRun(benchmarkId, workflowId),
    onSuccess: created => {
      setSelectedRun(created.id)
      void queryClient.invalidateQueries({ queryKey: ["benchmarks", "runs"] })
      toast.success("Run started")
    },
    onError: (error: Error) => toast.error(error.message || "The run could not be started"),
  })

  if (dataset.isLoading) return <LoadingState fullScreen />
  if (dataset.isError || !dataset.data) {
    return <ErrorState title="Dataset not found" description="It may have been removed, or it belongs to another workspace."
      retryAction={<Button variant="outline" asChild><Link to="/app/benchmarks">Back to benchmarks</Link></Button>} />
  }

  const data = dataset.data
  const workflowName = (id: string) => workflows.data?.find(item => item.id === id)?.name ?? id
  const caseNumber = new Map(data.cases.map(item => [item.id, item.position + 1]))

  return (
    <div className="space-y-6 max-w-6xl">
      <Link to="/app/benchmarks" className="inline-flex items-center text-sm text-text-muted hover:text-text-primary">
        <ArrowLeft className="mr-1 h-4 w-4" />Benchmarks
      </Link>
      <PageHeader title={data.name} description={data.description || `${data.caseCount} test cases`} />

      <PermissionGate permission="benchmark.create">
        <section className="rounded-xl border border-border bg-surface p-6 space-y-3" aria-label="Run this dataset">
          <Label htmlFor="benchmark-workflow">Run a workflow against this dataset</Label>
          <p className="text-xs text-text-muted">The workflow's active version runs through Simulate: model steps run and are costed, outside actions never fire.</p>
          <div className="flex gap-2">
            <Select id="benchmark-workflow" value={workflowId} onChange={event => setWorkflowId(event.target.value)} className="max-w-sm">
              <option value="">Choose a workflow</option>
              {(workflows.data ?? []).filter(item => item.status === "active").map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </Select>
            <Button disabled={!workflowId || start.isPending} onClick={() => start.mutate()}>
              <Play className="mr-2 h-4 w-4" />{start.isPending ? "Starting…" : "Run"}
            </Button>
          </div>
        </section>
      </PermissionGate>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text-primary">Runs</h2>
        {runs.isError ? <p className="text-sm text-destructive">Runs could not be loaded.</p>
          : (runs.data ?? []).length === 0 ? <p className="text-sm text-text-muted">No runs yet.</p> : (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead><TableHead>Workflow</TableHead><TableHead>Result</TableHead>
                    <TableHead>Tokens</TableHead><TableHead className="text-right">Estimated cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runs.data ?? []).map(item => (
                    <TableRow key={item.id} aria-selected={item.id === runId}
                      className={`cursor-pointer hover:bg-surface-hover ${item.id === runId ? "bg-surface-hover" : ""}`}
                      onClick={() => setSelectedRun(item.id)}>
                      <TableCell className="text-sm">{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</TableCell>
                      <TableCell className="text-sm">{workflowName(item.workflowId)}</TableCell>
                      <TableCell className="text-sm">{passRateLabel(item)}</TableCell>
                      <TableCell className="text-sm">{item.inputTokens + item.outputTokens}</TableCell>
                      <TableCell className="text-right text-sm">{costLabel(item.estimatedCostUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
      </section>

      {run.data && (
        <section className="space-y-3" aria-label="Case results">
          <h2 className="text-lg font-semibold text-text-primary">Case results</h2>
          {run.data.results.length === 0 ? <p className="text-sm text-text-muted">{passRateLabel(run.data)}</p> : (
            <ul className="space-y-2">
              {run.data.results.map(result => (
                <li key={result.caseId} className="rounded-lg border border-border bg-surface p-4 text-sm space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Case {caseNumber.get(result.caseId) ?? result.position + 1}</span>
                    <span className={result.verdict === "pass" ? "text-success" : "text-destructive"}>
                      {result.verdict === "pass" ? "Passed" : result.verdict === "fail" ? "Failed" : "Not run"}
                      {result.score !== null && ` · score ${result.score.toFixed(2)}`}
                    </span>
                  </div>
                  {result.error && <p className="text-text-muted">{result.error}</p>}
                  {result.steps.length > 0 && (
                    <p className="text-xs text-text-muted">
                      {result.steps.map(step => `${step.key}: ${step.status === "simulated" ? `simulated ${step.action ?? step.type}` : step.status}`).join(" → ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text-primary">Cases</h2>
        <ul className="space-y-2">
          {data.cases.map(item => (
            <li key={item.id} className="rounded-lg border border-border bg-surface p-4 text-sm space-y-2">
              <p className="font-medium">Case {item.position + 1}</p>
              <pre className="overflow-x-auto rounded bg-surface-raised p-2 text-xs">{JSON.stringify(item.input, null, 2)}</pre>
              <ul className="list-disc pl-5 text-text-secondary">
                {item.successCriteria.map(criterion => <li key={criterion}>{criterion}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
