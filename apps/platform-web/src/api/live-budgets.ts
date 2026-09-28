import { apiDelete, apiGet, apiPatch, apiPost, mutationKey } from "./http"
import type { Budget, BudgetThreshold } from "./types"

// Budgets (task B2.9b): live adapter over /api/v1/budgets. The API keeps
// amounts in minor units; the console's Budget keeps major units.

type AnyRecord = Record<string, unknown>

function mapBudget(value: unknown): Budget {
  const item = value as AnyRecord
  const spend = item.currentSpendMinor
  return {
    id: String(item.id),
    name: String(item.name),
    scope: "workspace",
    amount: Number(item.amountMinor) / 100,
    currency: String(item.currency),
    period: "monthly",
    currentSpend: typeof spend === "number" ? spend / 100 : null,
    enabled: item.enabled === true,
    thresholds: Array.isArray(item.thresholds) ? (item.thresholds as BudgetThreshold[]) : [],
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

export async function createBudget(input: Partial<Budget>): Promise<Budget> {
  return mapBudget(
    await apiPost<unknown>(
      "/api/v1/budgets",
      {
        name: input.name,
        amount_minor: toMinor(input.amount ?? 0),
        currency: input.currency,
        thresholds: input.thresholds ?? [],
        enabled: input.enabled ?? true,
      },
      { idempotencyKey: mutationKey("budget-create") },
    ),
  )
}

export async function updateBudget(id: string, input: Partial<Budget>): Promise<Budget> {
  return mapBudget(
    await apiPatch<unknown>(`/api/v1/budgets/${encodeURIComponent(id)}`, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.amount !== undefined ? { amount_minor: toMinor(input.amount) } : {}),
      ...(input.thresholds !== undefined ? { thresholds: input.thresholds } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    }),
  )
}

export async function deleteBudget(id: string): Promise<void> {
  await apiDelete<void>(`/api/v1/budgets/${encodeURIComponent(id)}`)
}
