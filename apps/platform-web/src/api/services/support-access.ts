import type { SupportAccessRequest } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-ops"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_REQUESTS: SupportAccessRequest[] = [
  { id: "req-1", tenantId: "ten-1", requestedBy: { id: "u-sys", name: "Admin (You)" }, reason: "Investigating workflow failure #405", status: "pending", requestedAt: new Date().toISOString(), scope: ["View workflow configuration", "View run logs"] },
  { id: "req-2", tenantId: "ten-2", requestedBy: { id: "u-sys", name: "Admin (You)" }, reason: "Billing inquiry", status: "approved", requestedAt: "2024-08-09T10:00:00Z", approvedAt: "2024-08-09T10:15:00Z", expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBy: { id: "usr-3", name: "Customer Admin" }, scope: ["View billing"] },
  { id: "req-3", tenantId: "ten-3", requestedBy: { id: "u-other", name: "Other Support" }, reason: "Onboarding help", status: "expired", requestedAt: "2024-07-01T10:00:00Z", approvedAt: "2024-07-01T10:15:00Z", expiresAt: "2024-07-02T10:15:00Z", scope: ["Read workspace metadata"] }
]

export class SupportAccessService {
  async list(): Promise<SupportAccessRequest[]> {
    if (isLiveApi) return live.listGrants()
    await delay(300)
    return MOCK_REQUESTS
  }

  async request(tenantId: string, reason: string, scope: string[]): Promise<SupportAccessRequest> {
    if (isLiveApi) throw new Error("Grants are created from the tenant page (Request access)")
    await delay(500)
    const req: SupportAccessRequest = {
      id: `req-${Date.now()}`,
      tenantId,
      requestedBy: { id: "u-sys", name: "Admin (You)" },
      reason,
      scope,
      status: "pending",
      requestedAt: new Date().toISOString()
    }
    MOCK_REQUESTS.unshift(req)
    return req
  }

  async approve(id: string): Promise<SupportAccessRequest> {
    if (isLiveApi) throw new Error("Grants take effect when a staff admin creates them; there is nothing to approve")
    await delay(400)
    const req = MOCK_REQUESTS.find(r => r.id === id)
    if (!req) throw new Error("Not found")
    req.status = "approved"
    req.approvedAt = new Date().toISOString()
    req.expiresAt = new Date(Date.now() + 3600000).toISOString() // 1 hour
    return req
  }

  async endSession(id: string): Promise<SupportAccessRequest> {
    if (isLiveApi) { await live.revokeGrant(id); const grant = (await live.listGrants()).find((g) => g.id === id); if (!grant) throw new Error("Grant not found"); return grant }
    await delay(300)
    const req = MOCK_REQUESTS.find(r => r.id === id)
    if (!req) throw new Error("Not found")
    req.status = "expired"
    return req
  }
}
