import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import type { Budget, BudgetThreshold } from "@/api/types"
import { formatCurrency, formatPercentage } from "@/lib/formatters"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2 } from "lucide-react"

// Live amounts are real money in the budget's own currency, so they are shown
// as they are; demo amounts go through the demo display-currency switch.
function money(amount: number, currency: string) {
  if (!isLiveApi) return formatCurrency(amount, currency)
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency }).format(amount)
}

export function BudgetsPage() {
  const queryClient = useQueryClient()
  const [creating, setCreating] = React.useState(false)
  const { data: budgets, isLoading, isError } = useQuery({
    queryKey: queryKeys.budgets.list,
    queryFn: () => api.budgets.list()
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.budgets.list })
  const toggle = useMutation({ mutationFn: (b: Budget) => api.budgets.update(b.id, { enabled: !b.enabled }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (b: Budget) => api.budgets.remove(b.id), onSuccess: refresh })
  const actionError = (toggle.error ?? remove.error) as Error | null

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading budgets...</div>

  return (
    <div className="space-y-8">
      <PageHeader
        title="Budgets"
        description="Set monthly spending limits for this workspace and see how close you are."
        primaryAction={
          <Button onClick={() => setCreating(true)} disabled={creating}>
            <Plus className="mr-2 h-4 w-4" />
            Create Budget
          </Button>
        }
      />
      {isError && <p role="alert" className="text-destructive">Could not load budgets.</p>}
      {actionError && <p role="alert" className="text-destructive">{actionError.message}</p>}
      {creating && <CreateBudgetForm onDone={() => { setCreating(false); refresh() }} onCancel={() => setCreating(false)} />}

      <div className="grid gap-6">
        {budgets?.map(budget => {
          const known = budget.currentSpend !== null
          const ratio = known ? budget.currentSpend! / budget.amount : 0

          let statusColor = "bg-primary"
          let statusVariant: "default" | "warning" | "danger" | "success" | "secondary" = "success"
          let statusText = "Healthy"
          if (!budget.enabled) {
            statusVariant = "secondary"
            statusText = "Paused"
          } else if (!known) {
            statusVariant = "default"
            statusText = "Spend unavailable"
          } else if (ratio >= 1) {
            statusColor = "bg-danger"
            statusVariant = "danger"
            statusText = "Exceeded"
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
                    {budget.name}
                    <Badge variant={statusVariant}>{statusText}</Badge>
                  </CardTitle>
                  <CardDescription className="capitalize mt-1">
                    {budget.scope} scope • {budget.period}
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(budget)}>
                    {budget.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${budget.name}`}
                    disabled={remove.isPending}
                    onClick={() => { if (window.confirm(`Delete the budget "${budget.name}"?`)) remove.mutate(budget) }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between items-end text-sm">
                  <div>
                    <span className="text-2xl font-bold">{known ? money(budget.currentSpend!, budget.currency) : "—"}</span>
                    <span className="text-muted-foreground ml-2">/ {money(budget.amount, budget.currency)}</span>
                  </div>
                  <div className="font-medium">{known ? formatPercentage(budget.currentSpend!, budget.amount) : ""}</div>
                </div>

                <div className="h-2 w-full bg-surface-hover rounded-full overflow-hidden">
                  <div
                    className={`h-full ${statusColor} transition-all`}
                    style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                  />
                </div>

                <div className="pt-2 flex flex-wrap gap-2">
                  {budget.thresholds.map((t, idx) => (
                    <Badge key={idx} variant="secondary" className="text-xs font-normal">
                      {t.action === 'notify' ? 'Notify' : t.action === 'warn' ? 'Warn' : 'Block'} at {t.percent}%
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )
        })}

        {budgets?.length === 0 && !creating && (
          <div className="text-center p-12 border border-dashed rounded-lg">
            <h3 className="text-lg font-medium">No budgets created</h3>
            <p className="text-muted-foreground mt-1">Create a budget to track spending limits.</p>
            <Button className="mt-4" onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" /> Create Budget</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function CreateBudgetForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = React.useState("")
  const [amount, setAmount] = React.useState("")
  const [currency, setCurrency] = React.useState("INR")
  const [warn, setWarn] = React.useState(true)
  const [block, setBlock] = React.useState(false)
  const create = useMutation({
    mutationFn: () => {
      const thresholds: BudgetThreshold[] = [
        ...(warn ? [{ percent: 80, action: "warn" as const }] : []),
        ...(block ? [{ percent: 100, action: "block" as const }] : []),
      ]
      return api.budgets.create({ name: name.trim(), amount: Number(amount), currency, thresholds, enabled: true })
    },
    onSuccess: onDone,
  })
  const valid = name.trim().length > 0 && Number(amount) > 0

  return (
    <Card>
      <CardHeader><CardTitle className="text-lg">New monthly budget</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-3" onSubmit={e => { e.preventDefault(); if (valid) create.mutate() }}>
          <div className="space-y-1 md:col-span-3">
            <Label htmlFor="budget-name">Name</Label>
            <Input id="budget-name" value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Workspace monthly" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="budget-amount">Limit</Label>
            <Input id="budget-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="budget-currency">Currency</Label>
            <select id="budget-currency" className="h-10 w-full rounded-md border bg-transparent px-3 text-sm" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={warn} onChange={e => setWarn(e.target.checked)} /> Warn at 80%</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={block} onChange={e => setBlock(e.target.checked)} /> Block at 100%</label>
          <p className="md:col-span-3 text-xs text-muted-foreground">
            Thresholds are saved with the budget. Alerts and blocking new runs when a threshold is reached are not active yet.
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
