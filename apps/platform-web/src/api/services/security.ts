import type { SecurityReviewItem } from "../types"
import type { SecurityReviewStaff } from "@alterx/contracts"
import { isLiveApi } from "../http"
import * as live from "../live-admin-ops"
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const MOCK_SECURITY: SecurityReviewItem[] = [
  { id: "sec-1", type: "suspicious_login", severity: "high", status: "open", tenantId: "ten-2", userId: "usr-3", title: "Suspicious login from restricted region", summary: "Multiple logins from EU-East despite policy.", createdAt: new Date(Date.now() - 86400000).toISOString() },
  { id: "sec-2", type: "rate_anomaly", severity: "medium", status: "investigating", tenantId: "ten-1", title: "API rate anomaly detected", summary: "Tenant exceeded normal run rate by 400% in 1 hour.", createdAt: new Date().toISOString() },
  { id: "sec-3", type: "abuse", severity: "critical", status: "resolved", tenantId: "ten-3", title: "Detected abusive prompt generation", summary: "Tenant flagged for generating abusive content.", createdAt: "2024-06-10T00:00:00Z" },
]
const versions = new Map(MOCK_SECURITY.map(item => [item.id, 1]))
for (const item of MOCK_SECURITY) item.etag = `"${item.id}:rev-1"`
const DEMO_STAFF: SecurityReviewStaff[] = [{ id: "stf_demo_security", email: "security@example.test", roles: ["staff_security"] }, { id: "stf_demo_admin", email: "admin@example.test", roles: ["staff_admin"] }]
function editable(id: string, etag: string, reason: string) {
  const item = MOCK_SECURITY.find(row => row.id === id)
  if (!item) throw new Error("Security review not found")
  if (item.etag !== etag) throw new Error("Reload the current security review")
  if (!["open", "investigating"].includes(item.status)) throw new Error("Security review is already closed")
  if (!reason.trim() || reason.trim().length > 1000) throw new Error("Enter a reason between 1 and 1000 characters")
  return item
}
function advance(item: SecurityReviewItem) {
  const revision = versions.get(item.id)! + 1; versions.set(item.id, revision); item.etag = `"${item.id}:rev-${revision}"`
}
export class SecurityService {
  async list(): Promise<SecurityReviewItem[]> {
    if (isLiveApi) return live.listSignals()
    await delay(300); return MOCK_SECURITY
  }
  async staff(): Promise<SecurityReviewStaff[]> {
    if (isLiveApi) return live.securityReviewStaff()
    return DEMO_STAFF
  }
  async resolve(id: string, resolution: "resolved" | "dismissed", reason: string, etag: string): Promise<SecurityReviewItem> {
    if (isLiveApi) return live.reviewSignal(id, resolution, reason, etag)
    await delay(100); const item = editable(id, etag, reason); item.status = resolution; advance(item); return item
  }
  async assign(id: string, staffUserId: string, reason: string, etag: string): Promise<SecurityReviewItem> {
    if (isLiveApi) return live.assignSignal(id, staffUserId, reason, etag)
    await delay(100); const item = editable(id, etag, reason), staff = DEMO_STAFF.find(row => row.id === staffUserId)
    if (!staff) throw new Error("Choose an active eligible staff member")
    item.assignment = { staffUserId, staffEmail: staff.email, active: true, assignedBy: "stf_demo_security", assignedAt: new Date().toISOString(), reason: reason.trim() }
    item.status = "investigating"; advance(item); return item
  }
}
