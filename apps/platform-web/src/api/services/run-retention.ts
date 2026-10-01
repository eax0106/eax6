import { isLiveApi } from "../http"
import { delay } from "../mock/data"
import * as liveRunRetention from "../live-run-retention"
import type { RunRetention } from "../types"

let mockRetention: RunRetention = { retentionDays: 365, isDefault: true, updatedAt: null, etag: '"mock-default"' }

export const runRetentionService = {
  get: async (): Promise<RunRetention> => {
    if (isLiveApi) return liveRunRetention.getRunRetention()
    await delay(300)
    return mockRetention
  },
  preview: async (retentionDays: number): Promise<number> => {
    if (isLiveApi) return liveRunRetention.previewRunRetention(retentionDays)
    await delay(300)
    return retentionDays < mockRetention.retentionDays ? 12 : 0
  },
  set: async (retentionDays: number, confirmLowering: boolean, etag: string): Promise<RunRetention> => {
    if (isLiveApi) return liveRunRetention.setRunRetention(retentionDays, confirmLowering, etag)
    await delay(300)
    if (retentionDays < mockRetention.retentionDays && !confirmLowering) throw new Error("Confirmation required")
    const updatedAt = new Date().toISOString()
    mockRetention = { retentionDays, isDefault: false, updatedAt, etag: `"mock-${updatedAt}"` }
    return mockRetention
  },
}
