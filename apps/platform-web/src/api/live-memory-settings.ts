import { WorkspaceMemorySettingsSchema, WorkspaceMemoryValuesSchema } from "@alterx/contracts"
import { apiGetWithEtag, apiPut, mutationKey } from "./http"
import type { MemoryConfiguration } from "./types"

const path = "/api/v1/memory-settings"
export async function getMemoryConfiguration(): Promise<MemoryConfiguration> {
  const response = await apiGetWithEtag<unknown>(path)
  const settings = WorkspaceMemorySettingsSchema.parse(response.data)
  if (!response.etag || response.etag !== settings.etag) throw new Error("Memory settings ETag missing or inconsistent")
  return settings
}
export async function updateMemoryConfiguration(input: Partial<MemoryConfiguration>): Promise<MemoryConfiguration> {
  const { etag, ...values } = input
  if (!etag) throw new Error("Memory settings ETag required")
  return WorkspaceMemorySettingsSchema.parse(await apiPut(path, WorkspaceMemoryValuesSchema.parse(values),
    { ifMatch: etag, idempotencyKey: mutationKey("memory-settings") }))
}
