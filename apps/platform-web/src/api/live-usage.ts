import { apiGet } from "./http"

// Usage and cost (task B2.9): live adapter over GET /api/v1/costs/summary, the
// cost ledger's rollup for the caller's workspace. Only the billable amount is
// shown to the tenant; the ledger's internal cost and margin are not.

export interface UsageCostLine {
  source: string
  provider: string
  resource: string
  billableMinor: number
  events: number
}

export interface UsageCostSummary {
  periodStart: string
  periodEnd: string
  currency: string
  billableMinor: number
  events: number
  lines: UsageCostLine[]
}

type AnyRecord = Record<string, unknown>

function minor(value: unknown): number {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid cost amount from the cost ledger")
  return amount
}

/** Spend from the first day of the current month (UTC) until now, by source, provider and resource. */
export async function getMonthToDateUsage(now = new Date()): Promise<UsageCostSummary> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const query = new URLSearchParams({ startAt: start.toISOString(), endAt: now.toISOString() })
  for (const dimension of ["source", "provider", "resource"]) query.append("dimensions", dimension)
  const body = (await apiGet<unknown>(`/api/v1/costs/summary?${query.toString()}`)) as AnyRecord
  const groups = Array.isArray(body.groups) ? (body.groups as AnyRecord[]) : []
  const lines = groups
    .map((group) => {
      const dimensions = (group.dimensions ?? {}) as AnyRecord
      return {
        source: String(dimensions.source ?? "unknown"),
        provider: String(dimensions.provider ?? "unknown"),
        resource: String(dimensions.resource ?? "unknown"),
        billableMinor: minor(group.billableMinor),
        events: Number(group.eventCount ?? 0),
      }
    })
    .sort((left, right) => right.billableMinor - left.billableMinor)
  const totals = (body.totals ?? {}) as AnyRecord
  return {
    periodStart: String(body.startAt),
    periodEnd: String(body.endAt),
    currency: String(body.currency),
    billableMinor: minor(totals.billableMinor),
    events: lines.reduce((sum, line) => sum + line.events, 0),
    lines,
  }
}
