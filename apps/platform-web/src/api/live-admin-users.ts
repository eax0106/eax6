import { apiGet, apiPost } from "./http"
import type { AdminNote, AdminUser } from "./types"

// Admin console, users (task B1.2): live adapter over /api/v1/admin/users.
// MFA and risk state are not served by the API yet and stay undefined.

type AnyRecord = Record<string, unknown>

function mapUser(value: unknown): AdminUser {
  const item = value as AnyRecord
  return {
    id: String(item.id),
    name: typeof item.display_name === "string" && item.display_name ? item.display_name : String(item.email),
    email: String(item.email),
    status: item.status === "suspended" ? "suspended" : "active",
    tenantIds: Array.isArray(item.tenant_ids) ? item.tenant_ids.map(String) : [],
    createdAt: String(item.created_at),
    lastActiveAt: typeof item.last_seen_at === "string" ? item.last_seen_at : undefined,
  }
}

export async function listUsers(): Promise<AdminUser[]> {
  const body = await apiGet<unknown>("/api/v1/admin/users")
  return (Array.isArray(body) ? body : []).map(mapUser)
}

export async function getUser(id: string): Promise<AdminUser> {
  return mapUser(await apiGet<unknown>(`/api/v1/admin/users/${encodeURIComponent(id)}`))
}

export async function getUserTimeline(id: string): Promise<AdminNote[]> {
  const body = await apiGet<unknown>(`/api/v1/admin/users/${encodeURIComponent(id)}/actions`)
  return (Array.isArray(body) ? body : []).map((value) => {
    const item = value as AnyRecord
    const reason = typeof item.reason === "string" && item.reason ? `: ${item.reason}` : ""
    return {
      id: String(item.id),
      userId: id,
      author: { id: "", name: String(item.staff_email) },
      body: `${String(item.action).replaceAll("_", " ")}${reason}`,
      createdAt: String(item.occurred_at),
    }
  })
}

export async function suspendUser(id: string, reason: string): Promise<AdminUser> {
  return mapUser(await apiPost<unknown>(`/api/v1/admin/users/${encodeURIComponent(id)}/actions/suspend`, { reason }))
}

export async function reinstateUser(id: string): Promise<AdminUser> {
  return mapUser(await apiPost<unknown>(`/api/v1/admin/users/${encodeURIComponent(id)}/actions/reinstate`))
}

export async function revokeUserSessions(id: string, reason: string): Promise<void> {
  await apiPost<unknown>(`/api/v1/admin/users/${encodeURIComponent(id)}/actions/revoke-sessions`, { reason })
}
