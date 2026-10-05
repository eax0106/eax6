import type { AdminTenant, AdminNote } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-tenants"
import type { SupportGrant } from "../live-admin-tenants"
import type { TenantDetailActivity } from "@alterx/contracts"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_TENANTS: AdminTenant[] = [
  { id: "ten-1", name: "Acme AI", slug: "acme-ai", status: "active", plan: "enterprise", memberCount: 142, workflowCount: 23, runCount30d: 45023, currentSpend: 3450.00, createdAt: "2024-01-15T00:00:00Z", lastActiveAt: new Date().toISOString(), region: "us-east" },
  { id: "ten-2", name: "Stark Industries", slug: "stark", status: "suspended", plan: "pro", memberCount: 5, workflowCount: 2, runCount30d: 800, currentSpend: 250.00, createdAt: "2024-03-20T00:00:00Z", lastActiveAt: new Date().toISOString(), region: "us-west" },
  { id: "ten-3", name: "Wayne Enterprises", slug: "wayne", status: "suspended", plan: "free", memberCount: 1, workflowCount: 0, runCount30d: 0, currentSpend: 0, createdAt: "2024-06-10T00:00:00Z", region: "eu-central" }
]

const MOCK_NOTES: Record<string, AdminNote[]> = {
  "ten-2": [
    { id: "note-1", tenantId: "ten-2", author: { id: "u-sys", name: "Admin (You)" }, body: "Suspended due to suspicious spike in API usage. Awaiting response.", createdAt: "2024-08-09T14:00:00Z" }
  ]
}

export class AdminTenantsService {
  async list(): Promise<AdminTenant[]> {
    if (isLiveApi) return live.listTenants()
    await delay(400)
    return MOCK_TENANTS
  }

  async get(id: string, grantId?: string): Promise<AdminTenant> {
    if (isLiveApi) return live.getTenant(id, grantId)
    await delay(300)
    const tenant = MOCK_TENANTS.find(t => t.id === id)
    if (!tenant) throw new Error("Tenant not found")
    return tenant
  }

  async getNotes(id: string, grantId?: string): Promise<AdminNote[]> {
    if (isLiveApi) return live.getTenantTimeline(id, grantId)
    await delay(200)
    return MOCK_NOTES[id] || []
  }

  async activity(id: string, grantId?: string): Promise<TenantDetailActivity> {
    if (isLiveApi) return live.getTenantActivity(id, grantId)
    await delay(100)
    if (!MOCK_TENANTS.some(tenant => tenant.id === id)) throw new Error("Tenant not found")
    const window = { tenant_id: id, start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" }
    // Explicit demo records for this screen; never substituted after a live error.
    return { ...window, workflow_count: 1, run_count: 1,
      members: { count: 1, members: [{ id: "usr_demo", email: "member@example.test", name: "Demo member", role: "member" }] },
      workflows: [{ id: "wf_demo", workspace_id: "ws_demo", name: "Demo support workflow", status: "active", updated_at: window.end_at }],
      runs: [{ id: "run_demo", workspace_id: "ws_demo", workflow_id: "wf_demo", status: "completed", created_at: "2026-10-04T12:00:00.000Z" }],
      spend: { ...window, currencies: [{ currency: "INR", billed_minor: "12345", event_count: 1 }] },
    }
  }

  async addNote(id: string, body: string, grantId?: string): Promise<AdminNote> {
    if (isLiveApi) return live.appendTenantNote(id, body, grantId)
    await delay(300)
    const newNote: AdminNote = {
      id: `note-${Date.now()}`,
      tenantId: id,
      author: { id: "u-sys", name: "Admin (You)" },
      body,
      createdAt: new Date().toISOString()
    }
    if (!MOCK_NOTES[id]) MOCK_NOTES[id] = []
    MOCK_NOTES[id].push(newNote)
    return newNote
  }

  async suspend(id: string, reason: string): Promise<AdminTenant> {
    if (isLiveApi) return live.suspendTenant(id, reason)
    await delay(500)
    const idx = MOCK_TENANTS.findIndex(t => t.id === id)
    if (idx === -1) throw new Error("Not found")
    MOCK_TENANTS[idx] = { ...MOCK_TENANTS[idx], status: "suspended" }
    await this.addNote(id, `Suspended. Reason: ${reason}`)
    return MOCK_TENANTS[idx]
  }

  async restore(id: string, reason: string): Promise<AdminTenant> {
    if (isLiveApi) return live.reinstateTenant(id)
    await delay(500)
    const idx = MOCK_TENANTS.findIndex(t => t.id === id)
    if (idx === -1) throw new Error("Not found")
    MOCK_TENANTS[idx] = { ...MOCK_TENANTS[idx], status: "active" }
    await this.addNote(id, `Restored. Reason: ${reason}`)
    return MOCK_TENANTS[idx]
  }

  /** Live: this staff member's active tenant:read grant. Demo mode needs none. */
  async activeGrant(tenantId: string): Promise<SupportGrant | undefined> {
    if (isLiveApi) return live.activeTenantGrant(tenantId)
    return { id: "jit_demo", tenantId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  }

  async requestAccess(tenantId: string, reasonText: string, minutes: number): Promise<SupportGrant> {
    if (isLiveApi) return live.requestTenantAccess(tenantId, reasonText, minutes)
    return { id: "jit_demo", tenantId, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() }
  }
}
