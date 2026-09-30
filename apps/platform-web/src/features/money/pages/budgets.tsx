import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import type { Budget, BudgetInput } from "@/api/types"
import { formatPercentage } from "@/lib/formatters"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2 } from "lucide-react"

// D3: budgets are in rupees and enforced when a run starts.
function money(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amount)
}

function describe(budget: Budget, workflowName: (id: string | null) => string): { title: string; subtitle: string } {
  if (budget.kind === "workspace") return { title: "Workspace budget", subtitle: "Every workflow in this workspace • monthly" }
  if (budget.kind === "workflow") return { title: workflowName(budget.workflowId), subtitle: `One workflow • ${budget.period ?? "monthly"}` }
  return { title: workflowName(budget.workflowId), subtitle: "Cap on each run of this workflow" }
}

export function BudgetsPage() {
  const queryClient = useQueryClient()
  const [creating, setCreating] = React.useState(false)
  const { data: budgets, isLoading, isError } = useQuery({
    queryKey: queryKeys.budgets.list,
    queryFn: () => api.budgets.list(),
  })
  const { data: workflows } = useQuery({ queryKey: queryKeys.workflows.all, queryFn: () => api.getWorkflows() })
  const workflowName = (id: string | null) => workflows?.find(w => w.id === id)?.name ?? "A workflow"
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.budgets.list })
  const toggle = useMutation({ mutationFn: (b: Budget) => api.budgets.update(b, { enabled: !b.enabled }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (b: Budget) => api.budgets.remove(b.id), onSuccess: refresh })
  const actionError = (toggle.error ?? remove.error) as Error | null

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading budgets...</div>

  return (
    <div className="space-y-8">
      <PageHeader
        title="Budgets"
        description="Spending limits Alter checks before every run starts. You are alerted at 50% and 80%."
        primaryAction={
          <Button onClick={() => setCreating(true)} disabled={creating}>
            <Plus className="mr-2 h-4 w-4" />
            Create Budget
          </Button>
        }
      />
      {isError && <p role="alert" className="text-destructive">Could not load budgets.</p>}
      {actionError && <p role="alert" className="text-destructive">{actionError.message}</p>}
      {creating && (
        <CreateBudgetForm
          workflows={workflows ?? []}
          onDone={() => { setCreating(false); refresh() }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="grid gap-6">
        {budgets?.map(budget => {
          const { title, subtitle } = describe(budget, workflowName)
          const known = budget.currentSpend !== null
          const ratio = known ? budget.currentSpend! / budget.amount : 0

          let statusColor = "bg-primary"
          let statusVariant: "default" | "warning" | "danger" | "success" | "secondary" = "success"
          let statusText = "Healthy"
          if (!budget.enabled) {
            statusVariant = "secondary"
            statusText = "Paused"
          } else if (budget.kind === "run_cap") {
            statusVariant = "default"
            statusText = "Active"
          } else if (!known) {
            statusVariant = "default"
            statusText = "Spend unavailable"
          } else if (ratio >= 1) {
            statusColor = "bg-danger"
            statusVariant = "danger"
            statusText = budget.mode === "hard" ? "Limit reached" : "Over limit"
          } else if (ratio >= 0.8) {
            statusColor = "bg-warning"
            statusVariant = "warning"
            statusText = "Near limit"
          }

          return (
            <Card key={budget.id}>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div>
                  <CardTitle className="text-lg flex items-center gap-3">
                    {title}
                    <Badge variant={statusVariant}>{statusText}</Badge>
                  </CardTitle>
                  <CardDescription className="mt-1">{subtitle}</CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(budget)}>
                    {budget.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${title}`}
                    disabled={remove.isPending}
                    onClick={() => { if (window.confirm(`Delete the budget "${title}"?`)) remove.mutate(budget) }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {budget.kind === "run_cap" ? (
                  <p className="text-sm">
                    A run whose worst-case cost is above <span className="font-semibold">{money(budget.amount)}</span>{" "}
                    {budget.mode === "hard" ? "does not start." : "starts, with a warning."}
                  </p>
                ) : (
                  <>
                    <div className="flex justify-between items-end text-sm">
                      <div>
                        <span className="text-2xl font-bold">{known ? money(budget.currentSpend!) : "—"}</span>
                        <span className="text-muted-foreground ml-2">/ {money(budget.amount)}</span>
                      </div>
                      <div className="font-medium">{known ? formatPercentage(budget.currentSpend!, budget.amount) : ""}</div>
                    </div>
                    <div className="h-2 w-full bg-surface-hover rounded-full overflow-hidden">
                      <div className={`h-full ${statusColor} transition-all`} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
                    </div>
                    {budget.reserved !== null && budget.reserved > 0 && (
                      <p className="text-xs text-muted-foreground">{money(budget.reserved)} held for runs still going.</p>
                    )}
                  </>
                )}
                <div className="pt-2 flex flex-wrap gap-2">
                  {budget.kind !== "run_cap" && (
                    <Badge variant="secondary" className="text-xs font-normal">Alerts at 50% and 80%</Badge>
                  )}
                  <Badge variant="secondary" className="text-xs font-normal">
                    {budget.mode === "hard" ? "Stops new runs at the limit" : "Warns only, runs still start"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          )
        })}

        {budgets?.length === 0 && !creating && (
          <div className="text-center p-12 border border-dashed rounded-lg">
            <h3 className="text-lg font-medium">No budgets created</h3>
            <p className="text-muted-foreground mt-1">Create a budget to stop or flag spending before a run starts.</p>
            <Button className="mt-4" onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" /> Create Budget</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function CreateBudgetForm({
  workflows,
  onDone,
  onCancel,
}: {
  workflows: readonly { id: string; name: string }[]
  onDone: () => void
  onCancel: () => void
}) {
  const [kind, setKind] = React.useState<BudgetInput["kind"]>("workspace")
  const [workflowId, setWorkflowId] = React.useState("")
  const [period, setPeriod] = React.useState<"daily" | "monthly">("monthly")
  const [amount, setAmount] = React.useState("")
  const [warnOnly, setWarnOnly] = React.useState(false)
  const create = useMutation({
    mutationFn: () =>
      api.budgets.create({
        kind,
        ...(kind === "workspace" ? {} : { workflowId }),
        ...(kind === "workflow" ? { period } : {}),
        amount: Number(amount),
        mode: warnOnly ? "warn" : "hard",
      }),
    onSuccess: onDone,
  })
  const valid = Number(amount) > 0 && (kind === "workspace" || workflowId.length > 0)

  return (
    <Card>
      <CardHeader><CardTitle className="text-lg">New budget</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-3" onSubmit={e => { e.preventDefault(); if (valid) create.mutate() }}>
          <div className="space-y-1 md:col-span-3">
            <Label htmlFor="budget-kind">Applies to</Label>
            <select
              id="budget-kind"
              className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
              value={kind}
              onChange={e => setKind(e.target.value as BudgetInput["kind"])}
            >
              <option value="workspace">This workspace, per month</option>
              <option value="workflow">One workflow, per day or month</option>
              <option value="run_cap">Each run of one workflow</option>
            </select>
          </div>
          {kind !== "workspace" && (
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="budget-workflow">Workflow</Label>
              <select
                id="budget-workflow"
                className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
                value={workflowId}
                onChange={e => setWorkflowId(e.target.value)}
              >
                <option value="">Choose a workflow</option>
                {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
          {kind === "workflow" && (
            <div className="space-y-1">
              <Label htmlFor="budget-period">Period</Label>
              <select
                id="budget-period"
                className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
                value={period}
                onChange={e => setPeriod(e.target.value as "daily" | "monthly")}
              >
                <option value="monthly">Monthly</option>
                <option value="daily">Daily</option>
              </select>
            </div>
          )}
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="budget-amount">Limit (₹)</Label>
            <Input id="budget-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm md:col-span-3">
            <input type="checkbox" checked={warnOnly} onChange={e => setWarnOnly(e.target.checked)} />
            Warn only: let runs start past the limit
          </label>
          <p className="md:col-span-3 text-xs text-muted-foreground">
            By default a run that would go over the limit does not start. Workspace admins are alerted at 50% and 80%.
          </p>
          <div className="md:col-span-3 flex items-center gap-2">
            <Button type="submit" disabled={!valid || create.isPending}>Create</Button>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            {create.isError && <p role="alert" className="text-sm text-destructive">{(create.error as Error).message}</p>}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
