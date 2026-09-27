import type { SecurityReviewItem } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-ops"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_SECURITY: SecurityReviewItem[] = [
  { id: "sec-1", type: "suspicious_login", severity: "high", status: "open", tenantId: "ten-2", userId: "usr-3", title: "Suspicious login from restricted region", summary: "Multiple logins from EU-East despite policy.", createdAt: new Date(Date.now() - 86400000).toISOString() },
  { id: "sec-2", type: "rate_anomaly", severity: "medium", status: "investigating", tenantId: "ten-1", title: "API rate anomaly detected", summary: "Tenant exceeded normal run rate by 400% in 1 hour.", createdAt: new Date().toISOString() },
  { id: "sec-3", type: "abuse", severity: "critical", status: "resolved", tenantId: "ten-3", title: "Detected abusive prompt generation", summary: "Tenant flagged for generating abusive content.", createdAt: "2024-06-10T00:00:00Z" }
]

export class SecurityService {
  async list(): Promise<SecurityReviewItem[]> {
    if (isLiveApi) return live.listSignals()
    await delay(300)
    return MOCK_SECURITY
  }

  async resolve(id: string, resolution: "resolved" | "dismissed"): Promise<SecurityReviewItem> {
    if (isLiveApi) return live.reviewSignal(id, resolution)
    await delay(500)
    const sec = MOCK_SECURITY.find(s => s.id === id)
    if (!sec) throw new Error("Not found")
    sec.status = resolution
    return sec
  }

  async assign(id: string): Promise<SecurityReviewItem> {
    if (isLiveApi) throw new Error("Assigning reviews is not available: platform-api has no assignee on abuse signals")
    await delay(300)
    const sec = MOCK_SECURITY.find(s => s.id === id)
    if (!sec) throw new Error("Not found")
    sec.status = "investigating"
    return sec
  }
}
