import type { ProviderDefinition } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-controls"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_PROVIDERS: ProviderDefinition[] = [
  { id: "prv-openai", name: "OpenAI", type: "model", status: "healthy", enabled: true, lastCheckedAt: new Date().toISOString(), latencyMs: 345, errorRate: 0.02, region: "us-east-1" },
  { id: "prv-anthropic", name: "Anthropic", type: "model", status: "degraded", enabled: true, lastCheckedAt: new Date().toISOString(), latencyMs: 1200, errorRate: 2.5, region: "us-west-2" },
  { id: "prv-primary-compute", name: "Primary Compute", type: "compute", status: "healthy", enabled: true, lastCheckedAt: new Date().toISOString(), latencyMs: 45, errorRate: 0.0, region: "global" },
  { id: "prv-aws-s3", name: "Object Storage", type: "storage", status: "healthy", enabled: true, lastCheckedAt: new Date().toISOString(), latencyMs: 12, errorRate: 0.0, region: "us-east-1" },
  { id: "prv-slack", name: "Slack Delivery", type: "messaging", status: "outage", enabled: false, lastCheckedAt: new Date(Date.now() - 3600000).toISOString(), latencyMs: 0, errorRate: 100, region: "global" }
]

export class ProvidersService {
  async list(): Promise<ProviderDefinition[]> {
    if (isLiveApi) return live.listProviders()
    await delay(300)
    return MOCK_PROVIDERS
  }

  async get(id: string): Promise<ProviderDefinition> {
    if (isLiveApi) { const found = (await live.listProviders()).find((p) => p.id === id); if (!found) throw new Error("Provider not found"); return found }
    await delay(200)
    const provider = MOCK_PROVIDERS.find(p => p.id === id)
    if (!provider) throw new Error("Not found")
    return provider
  }

  async enable(id: string): Promise<ProviderDefinition> {
    if (isLiveApi) return live.setProviderActive(id, true)
    await delay(400)
    const p = MOCK_PROVIDERS.find(p => p.id === id)
    if (!p) throw new Error("Not found")
    p.enabled = true
    return p
  }

  async disable(id: string): Promise<ProviderDefinition> {
    if (isLiveApi) return live.setProviderActive(id, false)
    await delay(400)
    const p = MOCK_PROVIDERS.find(p => p.id === id)
    if (!p) throw new Error("Not found")
    p.enabled = false
    return p
  }

  async markMaintenance(id: string): Promise<ProviderDefinition> {
    if (isLiveApi) throw new Error("Maintenance mode is not available: platform-api has no provider maintenance state")
    await delay(400)
    const p = MOCK_PROVIDERS.find(p => p.id === id)
    if (!p) throw new Error("Not found")
    p.status = "maintenance"
    return p
  }
}
