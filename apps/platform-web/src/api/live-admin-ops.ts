import { apiGet, apiPost } from "./http"
import type { Incident, SecurityReviewItem, SupportAccessRequest } from "./types"

// Admin console, incidents / security / support access (tasks B1.5, B1.8, B1.9):
// live adapter over /api/v1/admin/incidents, /api/v1/admin/abuse/signals and
// /api/v1/admin/staff-access/grants.

type AnyRecord = Record<string, unknown>
const CONSOLE_REASON = "Changed in the admin console"

// --- Incidents ---------------------------------------------------------------

function mapIncident(value: unknown): Incident {
  const item = value as AnyRecord
  return {
    id: String(item.id),
    title: String(item.title),
    severity: String(item.severity) as Incident["severity"],
    status: String(item.status) as Incident["status"],
    startedAt: String(item.created_at),
    affectedSystems: Array.isArray(item.impacted_services) ? item.impacted_services.map(String) : [],
    summary: typeof item.summary === "string" ? item.summary : undefined,
  }
}

export async function listIncidents(): Promise<Incident[]> {
  const body = await apiGet<unknown>("/api/v1/admin/incidents")
  return (Array.isArray(body) ? body : []).map(mapIncident)
}

export async function getIncident(id: string): Promise<Incident> {
  return mapIncident(await apiGet<unknown>(`/api/v1/admin/incidents/${encodeURIComponent(id)}`))
}

export async function setIncidentStatus(id: string, status: Incident["status"]): Promise<Incident> {
  return mapIncident(
    await apiPost<unknown>(`/api/v1/admin/incidents/${encodeURIComponent(id)}/actions/set-status`, {
      status,
      reason: CONSOLE_REASON,
    }),
  )
}

// --- Security: abuse signals -------------------------------------------------

const signalType: Record<string, SecurityReviewItem["type"]> = {
  payment_fraud: "abuse",
  free_tier_velocity: "rate_anomaly",
  credential_abuse: "credential_issue",
  marketplace_supply_chain: "policy_violation",
}

function severityFromScore(score: number): SecurityReviewItem["severity"] {
  if (score >= 80) return "critical"
  if (score >= 60) return "high"
  if (score >= 30) return "medium"
  return "low"
}

function mapSignal(value: unknown): SecurityReviewItem {
  const item = value as AnyRecord
  const type = String(item.signal_type)
  const score = Number(item.score)
  return {
    id: String(item.id),
    type: signalType[type] ?? "abuse",
    severity: severityFromScore(score),
    // "confirmed" is a closed review with abuse found; it reads as resolved here.
    status: item.status === "open" ? "open" : item.status === "dismissed" ? "dismissed" : "resolved",
    tenantId: String(item.tenant_id),
    title: type.replaceAll("_", " "),
    summary: `${String(item.source)} · score ${score} · ${String(item.evidence_ref)}`,
    createdAt: String(item.observed_at),
  }
}

export async function listSignals(): Promise<SecurityReviewItem[]> {
  const body = await apiGet<unknown>("/api/v1/admin/abuse/signals")
  return (Array.isArray(body) ? body : []).map(mapSignal)
}

export async function reviewSignal(id: string, resolution: "resolved" | "dismissed"): Promise<SecurityReviewItem> {
  return mapSignal(
    await apiPost<unknown>(`/api/v1/admin/abuse/signals/${encodeURIComponent(id)}/actions/review`, {
      decision: resolution === "resolved" ? "confirm" : "dismiss",
      reason: CONSOLE_REASON,
    }),
  )
}

// --- Support access: JIT grants ----------------------------------------------

function mapGrant(value: unknown): SupportAccessRequest {
  const item = value as AnyRecord
  const expired = Date.parse(String(item.expires_at)) <= Date.now()
  const status: SupportAccessRequest["status"] = item.revoked_at ? "revoked" : expired ? "expired" : "active"
  return {
    id: String(item.id),
    tenantId: String(item.tenant_id),
    requestedBy: { id: String(item.staff_user_id ?? ""), name: String(item.staff_user_id ?? "") },
    reason: String(item.reason_text ?? item.reason_code ?? ""),
    status,
    requestedAt: String(item.granted_at),
    approvedAt: String(item.granted_at),
    expiresAt: String(item.expires_at),
    scope: Array.isArray(item.scopes) ? item.scopes.map(String) : undefined,
  }
}

export async function listGrants(): Promise<SupportAccessRequest[]> {
  const body = (await apiGet<AnyRecord>("/api/v1/admin/staff-access/grants?limit=100")) ?? {}
  return (Array.isArray(body.data) ? body.data : []).map(mapGrant)
}

export async function revokeGrant(id: string): Promise<void> {
  await apiPost<unknown>(`/api/v1/admin/staff-access/grants/${encodeURIComponent(id)}/actions/revoke`)
}
