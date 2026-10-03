import { useInfiniteQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { api } from "@/api/client"
import type { HealthDimension, WorkflowHealth } from "@/api/types"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Badge } from "@/components/ui/badge"
import { ErrorState } from "@/components/feedback/error-state"
import { Button } from "@/components/ui/button"

export function WorkflowHealthList() {
  const query = useInfiniteQuery({
    queryKey: queryKeys.workflowHealth.all,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.getWorkflowHealths(pageParam),
    getNextPageParam: page => page.page.has_more ? page.page.next_cursor ?? undefined : undefined,
  })
  const healths = query.data?.pages.flatMap(page => page.data) ?? []
  return <div className="flex h-full flex-col">
    <PageHeader title="Workflow Health" description="Validation, Availability, Correctness, and Reliability from recorded workflow runs." />
    <div className="flex-1 overflow-auto p-8 pt-0 space-y-6">
      {query.isLoading && <p>Loading workflow health…</p>}
      {query.isError && <ErrorState title="Failed to load workflow health" description="There was a problem communicating with the server."
        retryAction={<Button onClick={() => query.refetch()}>Try Again</Button>} />}
      {!query.isLoading && !query.isError && healths.length === 0 && <p>No workflows available.</p>}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {healths.map(health => <HealthCard key={health.workflowId} health={health} />)}
      </div>
      {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more workflows</Button>}
    </div>
  </div>
}

const label = (status: HealthDimension["status"]) => status === "not_enough_data" ? "Not enough data" : status
const variant = (status: HealthDimension["status"]) => status === "healthy" ? "success" : status === "warning" ? "warning" : status === "critical" ? "danger" : "neutral"

export function HealthCard({ health }: { health: WorkflowHealth }) {
  return <article className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
    <div className="border-b border-border p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <Link className="font-semibold text-text-primary underline" to={`/app/workflows/${health.workflowId}`}>Workflow {health.workflowId}</Link>
        <Badge variant={variant(health.status)}>{label(health.status)}</Badge>
      </div>
      <p><strong className="text-3xl">{health.overallScore === null ? "—" : `${Math.round(health.overallScore * 10) / 10}%`}</strong> Overall health score</p>
    </div>
    <div className="p-5 space-y-4">
      {Object.entries(health.dimensions).map(([name, dimension]) => <DimensionRow key={name} name={name} dimension={dimension} />)}
    </div>
    <div className="border-t border-border p-4 text-xs text-text-muted space-y-1">
      <p>{health.recentFailures} failures, {health.degradedRuns} degraded runs</p>
      {health.window && <p>{health.window.sampledRuns} runs sampled; latest {health.window.maximumRuns} within 7 days.</p>}
      {health.window && <p>Window: {new Date(health.window.startAt).toLocaleString()} – {new Date(health.window.endAt).toLocaleString()}</p>}
      <p>Evaluated: {new Date(health.lastEvaluatedAt).toLocaleString()}</p>
    </div>
  </article>
}

function DimensionRow({ name, dimension }: { name: string; dimension: HealthDimension }) {
  return <div>
    <div className="flex justify-between gap-3 text-sm"><span className="capitalize">{name}</span>
      <span>{dimension.score === null ? "Not enough data" : `${Math.round(dimension.score * 10) / 10}%`}</span></div>
    {dimension.score !== null && <progress aria-label={`${name} score`} max={100} value={dimension.score} className="h-2 w-full" />}
    <p className="text-xs text-text-muted">{dimension.summary}</p>
    {dimension.observations !== undefined && <p className="text-xs text-text-muted">{dimension.passed}/{dimension.observations} recorded observations passed.</p>}
  </div>
}
