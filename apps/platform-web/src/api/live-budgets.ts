import { apiDelete, apiGet, apiPatch, apiPost, mutationKey } from "./http"
import type { Budget, BudgetInput } from "./types"

// Budgets (D3): live adapter over /api/v1/budgets, which platform-api relays
// to the engine. The API keeps paise; the console's Budget keeps rupees.

type AnyRecord = Record<string, unknown>

function minorToMajor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value / 100 : null
}

function mapBudget(value: unknown): Budget {
  const item = value as AnyRecord
  const kind = item.kind === "workflow" || item.kind === "run_cap" ? item.kind : "workspace"
  return {
    id: String(item.id),
    kind,
    workflowId: typeof item.workflow_id === "string" ? item.workflow_id : null,
    period: item.period === "daily" || item.period === "monthly" ? item.period : null,
    amount: minorToMajor(item.amount_minor) ?? 0,
    currency: "INR",
    mode: item.mode === "warn" ? "warn" : "hard",
    enabled: item.enabled === true,
    currentSpend: minorToMajor(item.spent_minor),
    reserved: minorToMajor(item.reserved_minor),
    updatedAt: String(item.updated_at),
  }
}

function toMinor(amount: number): number {
  const minor = Math.round(amount * 100)
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("Enter an amount greater than zero")
  return minor
}

export async function listBudgets(): Promise<Budget[]> {
  const body = await apiGet<unknown>("/api/v1/budgets")
  return (Array.isArray(body) ? body : []).map(mapBudget)
}

export async function createBudget(input: BudgetInput): Promise<Budget> {
  if (input.kind !== "workspace" && !input.workflowId) throw new Error("Choose a workflow")
  return mapBudget(
    await apiPost<unknown>(
      "/api/v1/budgets",
      {
        kind: input.kind,
        ...(input.kind === "workspace" ? {} : { workflow_id: input.workflowId }),
        ...(input.kind === "workflow" ? { period: input.period ?? "monthly" } : {}),
        amount_minor: toMinor(input.amount),
        mode: input.mode,
      },
      { idempotencyKey: mutationKey("budget-create") },
    ),
  )
}

export async function updateBudget(
  budget: Pick<Budget, "id" | "updatedAt">,
  input: { amount?: number; mode?: Budget["mode"]; enabled?: boolean },
): Promise<Budget> {
  return mapBudget(
    await apiPatch<unknown>(
      `/api/v1/budgets/${encodeURIComponent(budget.id)}`,
      {
        ...(input.amount !== undefined ? { amount_minor: toMinor(input.amount) } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
      { ifMatch: budget.updatedAt },
    ),
  )
}

export async function deleteBudget(id: string): Promise<void> {
  await apiDelete<void>(`/api/v1/budgets/${encodeURIComponent(id)}`)
}
