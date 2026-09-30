import { apiGet, apiPost, mutationKey } from "./http"

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

function mapExport(value: unknown): DataExport {
  const item = value as AnyRecord
  const status = item.status
  return {
    id: String(item.id),
    workspaceId: String(item.workspace_id ?? item.workspaceId),
    status: status === "running" || status === "ready" || status === "failed" || status === "expired" ? status : "requested",
    failureReason: typeof item.failure_reason === "string" ? item.failure_reason : (typeof item.failureReason === "string" ? item.failureReason : null),
    requestedAt: String(item.requested_at ?? item.requestedAt),
    updatedAt: String(item.updated_at ?? item.updatedAt),
    expiresAt: typeof item.expires_at === "string" ? item.expires_at : (typeof item.expiresAt === "string" ? item.expiresAt : null),
  }
}

function exportsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/exports`
}

export async function listDataExports(workspaceId: string): Promise<DataExport[]> {
  const body = await apiGet<unknown>(exportsPath(workspaceId))
  return (Array.isArray(body) ? body : []).map(mapExport)
}

export async function requestDataExport(workspaceId: string): Promise<DataExport> {
  return mapExport(
    await apiPost<unknown>(exportsPath(workspaceId), {}, { idempotencyKey: mutationKey("data-export-create") }),
  )
}

export async function getDataExport(workspaceId: string, exportId: string): Promise<DataExport> {
  return mapExport(await apiGet<unknown>(`${exportsPath(workspaceId)}/${encodeURIComponent(exportId)}`))
}

export async function downloadDataExport(workspaceId: string, exportId: string): Promise<DataExportArchive> {
  const body = (await apiGet<unknown>(`${exportsPath(workspaceId)}/${encodeURIComponent(exportId)}/download`)) as AnyRecord
  return {
    exportedAt: String(body.exportedAt ?? body.exported_at),
    workspaceId: String(body.workspaceId ?? body.workspace_id),
    workflows: Array.isArray(body.workflows) ? body.workflows : [],
    workflowVersions: Array.isArray(body.workflowVersions) ? body.workflowVersions : (Array.isArray(body.workflow_versions) ? body.workflow_versions : []),
    runs: Array.isArray(body.runs) ? body.runs : [],
    knowledgeSources: Array.isArray(body.knowledgeSources) ? body.knowledgeSources : [],
    knowledgeDocuments: Array.isArray(body.knowledgeDocuments) ? body.knowledgeDocuments : [],
    members: Array.isArray(body.members) ? body.members : [],
  }
}
