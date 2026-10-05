import { apiGet, apiPost } from "./http"
import { getStaffSession } from "./staff-auth"
import type { AdminNote, AdminTenant } from "./types"
import { TenantDetailActivitySchema, type TenantDetailActivity } from "@alterx/contracts"

// Admin console, tenants (task B1.1): live adapter over
// /api/v1/admin/tenants and /api/v1/admin/staff-access. Fields the API does
// not serve (member, workflow and run counts, spend, slug) stay undefined
// rather than invented.

type AnyRecord = Record<string, unknown>
const GRANT_HEADER = "x-alter-support-grant"

function mapTenant(value: unknown): AdminTenant {
  const item = value as AnyRecord
  const entitlement = item.entitlement as AnyRecord | undefined
  return {
    id: String(item.id),
    name: String(item.name),
    status: String(item.status) as AdminTenant["status"],
    plan: entitlement ? String(entitlement.plan) : undefined,
    region: typeof item.region === "string" ? item.region : undefined,
    createdAt: String(item.created_at),
  }
}

export async function listTenants(): Promise<AdminTenant[]> {
  const body = await apiGet<unknown>("/api/v1/admin/tenants")
  return (Array.isArray(body) ? body : []).map(mapTenant)
}

export async function getTenant(id: string, grantId?: string): Promise<AdminTenant> {
  return mapTenant(
    await apiGet<unknown>(`/api/v1/admin/tenants/${encodeURIComponent(id)}`, {
      headers: grantId ? { [GRANT_HEADER]: grantId } : undefined,
    }),
  )
}

export async function getTenantActivity(id: string, grantId?: string): Promise<TenantDetailActivity> {
  const result = TenantDetailActivitySchema.parse(await apiGet<unknown>(`/api/v1/admin/tenants/${encodeURIComponent(id)}/activity`, {
    headers: grantId ? { [GRANT_HEADER]: grantId } : undefined,
  }))
  if (result.tenant_id !== id) throw new Error("Tenant activity response does not match this tenant")
  return result
}

/** The tenant's staff action history, shown as its admin notes. */
export async function getTenantTimeline(id: string, grantId?: string): Promise<AdminNote[]> {
  const body = await apiGet<unknown>(`/api/v1/admin/tenants/${encodeURIComponent(id)}/actions`, {
    headers: grantId ? { [GRANT_HEADER]: grantId } : undefined,
  })
  return (Array.isArray(body) ? body : []).map((value) => {
    const item = value as AnyRecord
    const reason = typeof item.reason === "string" && item.reason ? `: ${item.reason}` : ""
    return {
      id: String(item.id),
      tenantId: id,
      author: { id: "", name: String(item.staff_email) },
      body: `${String(item.action).replaceAll("_", " ")}${reason}`,
      createdAt: String(item.occurred_at),
    }
  })
}

export async function appendTenantNote(id: string, body: string, grantId?: string): Promise<AdminNote> {
  const item = await apiPost<AnyRecord>(`/api/v1/admin/tenants/${encodeURIComponent(id)}/notes`, {body}, {headers: grantId ? {[GRANT_HEADER]: grantId} : undefined});
  return {id: String(item.id), tenantId: id, author: {id: "", name: String(item.staff_email)},
    body: String(item.reason), createdAt: String(item.occurred_at)};
}

export async function suspendTenant(id: string, reason: string): Promise<AdminTenant> {
  return mapTenant(
    await apiPost<unknown>(`/api/v1/admin/tenants/${encodeURIComponent(id)}/actions/suspend`, { reason }),
  )
}

export async function reinstateTenant(id: string): Promise<AdminTenant> {
  return mapTenant(await apiPost<unknown>(`/api/v1/admin/tenants/${encodeURIComponent(id)}/actions/reinstate`))
}

export interface SupportGrant {
  id: string
  tenantId: string
  expiresAt: string
}

/** This staff member's active tenant:read grant for a tenant, if any. */
export async function activeTenantGrant(tenantId: string): Promise<SupportGrant | undefined> {
  const body = (await apiGet<AnyRecord>("/api/v1/admin/staff-access/grants?limit=100")) ?? {}
  const now = Date.now()
  const rows = Array.isArray(body.data) ? (body.data as AnyRecord[]) : []
  const grant = rows.find(
    (row) =>
      row.tenant_id === tenantId &&
      !row.revoked_at &&
      Date.parse(String(row.expires_at)) > now &&
      (!Array.isArray(row.scopes) || (row.scopes as unknown[]).includes("tenant:read")),
  )
  return grant ? { id: String(grant.id), tenantId, expiresAt: String(grant.expires_at) } : undefined
}

/** A staff admin grants themselves time-boxed, reason-coded tenant:read access. */
export async function requestTenantAccess(tenantId: string, reasonText: string, minutes: number): Promise<SupportGrant> {
  const session = await getStaffSession()
  const grant = await apiPost<AnyRecord>("/api/v1/admin/staff-access/grants", {
    staff_user_id: session.staffUserId,
    tenant_id: tenantId,
    reason_code: "support_investigation",
    reason_text: reasonText,
    duration_minutes: minutes,
    scopes: ["tenant:read"],
  })
  return { id: String(grant.id), tenantId, expiresAt: String(grant.expires_at) }
}
