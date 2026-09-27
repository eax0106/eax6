import type { FeatureFlag } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-controls"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_FLAGS: FeatureFlag[] = [
  { id: "ff-2", key: "marketplace_seller", name: "Marketplace Seller Console", description: "Enable seller onboarding.", enabled: true, scope: "global", updatedAt: "2024-07-15T00:00:00Z", updatedBy: { id: "u-sys", name: "System Admin" } },
  { id: "ff-3", key: "workflow_benchmarks", name: "Workflow Benchmarks", description: "Enable benchmarking tools.", enabled: true, scope: "global", updatedAt: "2024-08-10T00:00:00Z", updatedBy: { id: "u-sys", name: "System Admin" } },
  { id: "ff-4", key: "new_run_inspector", name: "New Run Inspector", description: "Beta testing the new run inspector UX.", enabled: false, scope: "tenant", tenantIds: ["ten-1"], updatedAt: new Date().toISOString(), updatedBy: { id: "u-sys", name: "System Admin" } },
  { id: "ff-5", key: "hindi_localization", name: "Hindi Localization", description: "Enable Hindi i18n support.", enabled: true, scope: "global", updatedAt: "2024-08-10T12:00:00Z", updatedBy: { id: "u-sys", name: "System Admin" } }
]

export class FeatureFlagsService {
  async list(): Promise<FeatureFlag[]> {
    if (isLiveApi) return live.listFeatureFlags()
    await delay(200)
    return MOCK_FLAGS
  }

  async update(id: string, updates: Partial<FeatureFlag>): Promise<FeatureFlag> {
    if (isLiveApi) {
      const current = (await live.listFeatureFlags()).find((flag) => flag.id === id)
      if (!current) throw new Error("Feature flag not found")
      return live.updateFeatureFlag(current, updates.enabled ?? current.enabled)
    }
    await delay(300)
    const flag = MOCK_FLAGS.find(f => f.id === id)
    if (!flag) throw new Error("Not found")
    Object.assign(flag, updates)
    flag.updatedAt = new Date().toISOString()
    flag.updatedBy = { id: "u-sys", name: "Admin (You)" }
    return flag
  }
}
