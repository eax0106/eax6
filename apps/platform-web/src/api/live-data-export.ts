import { apiGet, apiPost, mutationKey } from "./http"
import { z } from "zod"

// Data exports (D2, C74): live adapter over /api/v1/workspaces/:id/exports,
// which platform-api answers from its durable export records. The archive
// itself is built asynchronously by the export sweep; the page polls the
// record until it is ready, failed or expired.

export type DataExportStatus = "requested" | "running" | "ready" | "failed" | "expired"

export interface DataExport {
  id: string
  workspaceId: string
  status: DataExportStatus
  failureReason: string | null
  requestedAt: string
  updatedAt: string
  expiresAt: string | null
}

export interface DataExportArchive {
  exportedAt: string
  workspaceId: string
  workflows: unknown[]
  workflowVersions: unknown[]
  runs: unknown[]
  knowledgeSources: unknown[]
  knowledgeDocuments: unknown[]
  members: unknown[]
}

type AnyRecord = Record<string, unknown>

const exportSchema = z.object({
  id: z.string().min(1), workspaceId: z.string().min(1),
  status: z.enum(["requested", "running", "ready", "failed", "expired"]),
  failureReason: z.string().nullable(),
  requestedAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
})
const archiveSchema = z.object({
  exportedAt: z.string().datetime({ offset: true }), workspaceId: z.string().min(1),
  workflows: z.array(z.unknown()), workflowVersions: z.array(z.unknown()), runs: z.array(z.unknown()),
  knowledgeSources: z.array(z.unknown()), knowledgeDocuments: z.array(z.unknown()), members: z.array(z.unknown()),
})

function responseRecord(value: unknown): AnyRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed workspace export response")
  return value as AnyRecord
}

function mapExport(value: unknown, workspaceId: string): DataExport {
  const item = responseRecord(value)
  const parsed = exportSchema.safeParse({
    id: item.id, workspaceId: item.workspace_id ?? item.workspaceId, status: item.status,
    failureReason: item.failure_reason ?? item.failureReason ?? null,
    requestedAt: item.requested_at ?? item.requestedAt, updatedAt: item.updated_at ?? item.updatedAt,
    expiresAt: item.expires_at ?? item.expiresAt ?? null,
  })
  if (!parsed.success || parsed.data.workspaceId !== workspaceId) throw new Error("Malformed workspace export response")
  return { ...parsed.data, failureReason: parsed.data.failureReason ?? null, expiresAt: parsed.data.expiresAt ?? null }
}

function exportsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/exports`
}

export async function listDataExports(workspaceId: string): Promise<DataExport[]> {
  const body = await apiGet<unknown>(exportsPath(workspaceId))
  if (!Array.isArray(body)) throw new Error("Malformed workspace export list")
  return body.map((value) => mapExport(value, workspaceId))
}

export async function requestDataExport(workspaceId: string): Promise<DataExport> {
  return mapExport(
    await apiPost<unknown>(exportsPath(workspaceId), {}, { idempotencyKey: mutationKey("data-export-create") }),
    workspaceId,
  )
}

export async function getDataExport(workspaceId: string, exportId: string): Promise<DataExport> {
  const record = mapExport(await apiGet<unknown>(`${exportsPath(workspaceId)}/${encodeURIComponent(exportId)}`), workspaceId)
  if (record.id !== exportId) throw new Error("Malformed workspace export response")
  return record
}

export async function downloadDataExport(workspaceId: string, exportId: string): Promise<DataExportArchive> {
  const body = responseRecord(await apiGet<unknown>(`${exportsPath(workspaceId)}/${encodeURIComponent(exportId)}/download`))
  const parsed = archiveSchema.safeParse({
    exportedAt: body.exportedAt ?? body.exported_at, workspaceId: body.workspaceId ?? body.workspace_id,
    workflows: body.workflows, workflowVersions: body.workflowVersions ?? body.workflow_versions,
    runs: body.runs, knowledgeSources: body.knowledgeSources, knowledgeDocuments: body.knowledgeDocuments, members: body.members,
  })
  if (!parsed.success || parsed.data.workspaceId !== workspaceId) throw new Error("Malformed workspace export archive")
  return parsed.data
}
