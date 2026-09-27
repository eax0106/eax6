import { apiGet } from "./http"
import type { AuditEvent } from "./types"

// Admin console, audit explorer (task B1.3): live adapter over
// /api/v1/admin/audit-events (the hash-chained audit ledger). Events carry no
// tenant id or category: tenant filtering is done by the API, and the category
// is read from the action's first segment -- "other" when it names none.

type AnyRecord = Record<string, unknown>

const categories = new Set<AuditEvent["category"]>([
  "authentication", "workspace", "workflow", "run", "human_action", "connection",
  "knowledge", "billing", "marketplace", "support", "security", "admin",
])
const prefixCategory: Record<string, AuditEvent["category"]> = {
  auth: "authentication",
  session: "authentication",
  tenant: "admin",
  user: "admin",
  staff: "admin",
  integration: "connection",
  credential: "connection",
}

function categoryOf(action: string): AuditEvent["category"] {
  const prefix = action.split(/[._]/)[0] ?? ""
  if (categories.has(prefix as AuditEvent["category"])) return prefix as AuditEvent["category"]
  return prefixCategory[prefix] ?? "other"
}

function actorType(value: unknown): AuditEvent["actor"]["type"] {
  return value === "admin" || value === "support" || value === "user" ? value : "system"
}

function outcome(value: unknown): AuditEvent["outcome"] {
  if (value === "success") return "success"
  if (value === "denied") return "denied"
  return "failure"
}

function parseContext(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function mapEvent(value: unknown): AuditEvent {
  const item = value as AnyRecord
  const action = String(item.action)
  return {
    id: String(item.id),
    timestamp: String(item.occurred_at),
    actor: { type: actorType(item.actor_type), id: String(item.actor_ref), name: String(item.actor_ref) },
    action,
    category: categoryOf(action),
    target: item.target_type ? { type: String(item.target_type), id: String(item.target_ref) } : undefined,
    outcome: outcome(item.result),
    metadata: parseContext(item.context_json),
  }
}

export async function listAuditEvents(filters?: Record<string, string>): Promise<AuditEvent[]> {
  const query = new URLSearchParams({ limit: "200" })
  if (filters?.tenantId) query.set("tenant_id", filters.tenantId)
  const body = (await apiGet<AnyRecord>(`/api/v1/admin/audit-events?${query}`)) ?? {}
  const events = (Array.isArray(body.events) ? body.events : []).map(mapEvent)
  return filters?.category ? events.filter((event) => event.category === filters.category) : events
}
