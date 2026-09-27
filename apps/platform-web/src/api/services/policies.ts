import type { PlatformPolicy } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-controls"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_POLICIES: PlatformPolicy[] = [
  { id: "pol-1", name: "Max Automatic Refund", category: "billing", status: "active", description: "Maximum amount that can be automatically refunded without human approval.", scope: "global", config: { maxAmount: 100, currency: "USD" }, updatedAt: "2024-01-15T00:00:00Z", updatedBy: { id: "u-sys", name: "System Admin" } },
  { id: "pol-2", name: "Allowed Model Providers", category: "execution", status: "active", description: "Providers allowed for workflow execution.", scope: "global", config: { allowed: ["openai", "anthropic", "google"] }, updatedAt: "2024-06-01T00:00:00Z", updatedBy: { id: "u-sys", name: "System Admin" } },
  { id: "pol-3", name: "Strict Data Retention", category: "data", status: "draft", description: "Enforce strict 7-day data retention.", scope: "tenant", config: { retentionDays: 7 }, updatedAt: new Date().toISOString(), updatedBy: { id: "u-sys", name: "System Admin" } }
]

export class PoliciesService {
  async list(): Promise<PlatformPolicy[]> {
    if (isLiveApi) return live.listPolicies()
    await delay(300)
    return MOCK_POLICIES
  }

  async update(id: string, updates: Partial<PlatformPolicy>): Promise<PlatformPolicy> {
    if (isLiveApi) throw new Error("Editing policies here is not available yet: change plan limits and model aliases through their own admin routes")
    await delay(400)
    const pol = MOCK_POLICIES.find(p => p.id === id)
    if (!pol) throw new Error("Not found")
    Object.assign(pol, updates)
    pol.updatedAt = new Date().toISOString()
    return pol
  }
}
