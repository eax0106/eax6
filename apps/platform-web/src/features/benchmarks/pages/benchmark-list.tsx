import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { formatDistanceToNow } from "date-fns"
import { BarChart2, Plus } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { LoadingState } from "@/components/feedback/loading-state"
import { EmptyState } from "@/components/feedback/empty-state"
import { ErrorState } from "@/components/feedback/error-state"
import { PermissionGate } from "@/features/permissions/components/permission-gate"
import { passRateLabel } from "../run-format"

const DESCRIPTION = "Test cases for your workflows: each case is an input and the success criteria it should meet. Runs use Simulate, so no outside action fires."

export function BenchmarkListPage() {
  const navigate = useNavigate()
  const datasets = useQuery({ queryKey: queryKeys.benchmarks.datasets, queryFn: () => api.benchmarks.listDatasets() })
  const runs = useQuery({ queryKey: queryKeys.benchmarks.runs(), queryFn: () => api.benchmarks.listRuns() })

  const newDataset = (
    <PermissionGate permission="benchmark.create">
      <Button onClick={() => navigate("/app/benchmarks/new")}>
        <Plus className="mr-2 h-4 w-4" />
        New dataset
      </Button>
    </PermissionGate>
  )

  if (datasets.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Benchmarks" description={DESCRIPTION} />
        <LoadingState fullScreen />
      </div>
    )
  }
  if (datasets.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Benchmarks" description={DESCRIPTION} />
        <ErrorState title="Benchmarks could not be loaded" description="Try again in a moment."
          retryAction={<Button variant="outline" onClick={() => void datasets.refetch()}>Retry</Button>} />
      </div>
    )
  }

  const latest = new Map<string, NonNullable<typeof runs.data>[number]>()
  for (const run of runs.data ?? []) if (!latest.has(run.datasetId)) latest.set(run.datasetId, run)
  const rows = datasets.data ?? []

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader title="Benchmarks" description={DESCRIPTION} primaryAction={newDataset} />
      {rows.length === 0 ? (
        <EmptyState
          icon={BarChart2}
          title="No benchmark datasets"
          description="Create a dataset of test cases, then run a workflow against it to see how often it meets each case's criteria."
          primaryAction={newDataset}
        />
      ) : (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dataset</TableHead>
                <TableHead>Cases</TableHead>
                <TableHead>Latest run</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(dataset => {
                const run = latest.get(dataset.id)
                return (
                  <TableRow key={dataset.id} className="cursor-pointer hover:bg-surface-hover transition-colors"
                    onClick={() => navigate(`/app/benchmarks/${dataset.id}`)}>
                    <TableCell>
                      <p className="font-medium text-text-primary">{dataset.name}</p>
                      {dataset.description && <p className="text-xs text-text-muted mt-1 truncate max-w-xs">{dataset.description}</p>}
                    </TableCell>
                    <TableCell className="text-sm">{dataset.caseCount}</TableCell>
                    <TableCell className="text-sm">{run ? passRateLabel(run) : runs.isError ? "Unavailable" : "Not run yet"}</TableCell>
                    <TableCell className="text-right text-sm text-text-muted">
                      {formatDistanceToNow(new Date(dataset.createdAt), { addSuffix: true })}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
