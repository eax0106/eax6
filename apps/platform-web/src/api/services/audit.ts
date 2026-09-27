import type { AuditEvent } from "../types"
import { isLiveApi } from "../http"
import { listAuditEvents } from "../live-admin-audit"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const generateMockAudits = (): AuditEvent[] => {
  const events: AuditEvent[] = []
  const categories: AuditEvent["category"][] = ["authentication", "workspace", "workflow", "run", "billing", "security", "admin"]
  
  for (let i = 0; i < 50; i++) {
    events.push({
      id: `evt-${1000 - i}`,
      timestamp: new Date(Date.now() - i * 3600000).toISOString(),
      actor: { type: i % 5 === 0 ? "admin" : "user", id: `u-${i%3}`, name: i % 5 === 0 ? "System Admin" : "User " + (i%3) },
      action: i % 5 === 0 ? "admin.tenant.suspend" : "workflow.run.started",
      category: categories[i % categories.length],
      tenantId: `ten-${(i%3)+1}`,
      outcome: i % 10 === 0 ? "failure" : "success",
      ipAddress: `192.168.1.${i%255}`,
      metadata: { detail: "Mock detail information" }
    })
  }
  return events
}

const MOCK_AUDITS = generateMockAudits()

export class AuditService {
  async list(filters?: Record<string, string>): Promise<AuditEvent[]> {
    if (isLiveApi) return listAuditEvents(filters)
    await delay(400)
    let filtered = MOCK_AUDITS
    if (filters?.tenantId) {
      filtered = filtered.filter(e => e.tenantId === filters.tenantId)
    }
    if (filters?.category) {
      filtered = filtered.filter(e => e.category === filters.category)
    }
    return filtered
  }
}
