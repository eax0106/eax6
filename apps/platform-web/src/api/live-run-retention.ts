import { apiGet, apiGetWithEtag, apiPut, mutationKey } from "./http"
import type { RunRetention } from "./types"

// Run-history retention (D2): live adapter over /api/v1/run-retention, which
// platform-api relays to the engine for the current workspace.

type AnyRecord = Record<string, unknown>

function mapRetention(value: AnyRecord, etag: string | undefined): RunRetention {
  return {
    retentionDays: Number(value.retention_days),
    isDefault: value.is_default === true,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
    etag: etag ?? String(value.etag ?? ""),
  }
}

export async function getRunRetention(): Promise<RunRetention> {
  const { data, etag } = await apiGetWithEtag<AnyRecord>("/api/v1/run-retention")
  return mapRetention(data, etag)
}

export async function previewRunRetention(retentionDays: number): Promise<number> {
  const body = await apiGet<AnyRecord>(`/api/v1/run-retention/preview?retention_days=${retentionDays}`)
  return Number(body.runs_to_delete)
}

/** Lowering needs confirmLowering after the person has seen the preview count. */
export async function setRunRetention(retentionDays: number, confirmLowering: boolean, etag: string): Promise<RunRetention> {
  const body = await apiPut<AnyRecord>(
    "/api/v1/run-retention",
    { retention_days: retentionDays, confirm_lowering: confirmLowering },
    { ifMatch: etag, idempotencyKey: mutationKey("run-retention") },
  )
  return mapRetention(body, undefined)
}
