import type { Incident } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-ops"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_INCIDENTS: Incident[] = [
  { id: "inc-1", title: "API Gateway Latency Spike", severity: "sev2", status: "investigating", startedAt: new Date(Date.now() - 3600000).toISOString(), commander: { id: "u-sys", name: "System Admin" }, affectedSystems: ["API", "Workflow execution"], summary: "We are investigating elevated latency across all API routes." },
  { id: "inc-2", title: "Slack Delivery Outage", severity: "sev3", status: "identified", startedAt: new Date(Date.now() - 7200000).toISOString(), commander: { id: "u-dev", name: "Dev Ops" }, affectedSystems: ["Connections"], summary: "Slack API is returning 5xx errors for incoming webhooks." },
  { id: "inc-3", title: "Database Failover", severity: "sev1", status: "resolved", startedAt: "2024-08-01T02:00:00Z", resolvedAt: "2024-08-01T02:45:00Z", commander: { id: "u-sys", name: "System Admin" }, affectedSystems: ["API", "Workflow execution", "Billing"], summary: "Primary database failed over. Service restored." }
]

export class IncidentsService {
  async list(): Promise<Incident[]> {
    if (isLiveApi) return live.listIncidents()
    await delay(300)
    return MOCK_INCIDENTS
  }

  async get(id: string): Promise<Incident> {
    if (isLiveApi) return live.getIncident(id)
    await delay(200)
    const inc = MOCK_INCIDENTS.find(i => i.id === id)
    if (!inc) throw new Error("Not found")
    return inc
  }

  async update(id: string, updates: Partial<Incident>): Promise<Incident> {
    if (isLiveApi) { if (!updates.status) throw new Error("Only the incident status can be changed here"); return live.setIncidentStatus(id, updates.status) }
    await delay(400)
    const inc = MOCK_INCIDENTS.find(i => i.id === id)
    if (!inc) throw new Error("Not found")
    Object.assign(inc, updates)
    if (updates.status === "resolved" && !inc.resolvedAt) {
      inc.resolvedAt = new Date().toISOString()
    }
    return inc
  }
}
