import { WorkflowFolderIdSchema, WorkflowFolderInputSchema, WorkflowIdSchema, WorkflowFolderListSchema, WorkflowFolderMoveSchema, WorkflowFolderPlacementSchema, WorkflowFolderSchema, type WorkflowFolder, type WorkflowFolderPlacement } from "@alterx/contracts"
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiHttpError, isLiveApi, mutationKey } from "./http"
import { delay, mockWorkflows } from "./mock/data"

const mockFolders: WorkflowFolder[] = []
let mockId = 0
const mockWorkspace = "ws_00000000-0000-7000-8000-000000000001"
function checkMatch(current: string, expected: string) {
  if (current !== expected) throw new ApiHttpError({ code: "PRECONDITION_FAILED", message: "Resource changed; reload before editing" }, 412)
}
function mockPlacement(id: string): WorkflowFolderPlacement {
  const workflow = mockWorkflows.find(item => item.id === id)
  if (!workflow) throw new Error("Workflow was not found")
  return { workflowId: id, folderId: workflow.folderId ?? null, etag: workflow.folderEtag ?? `"workflow-folder-${id}-0"` }
}

export async function getWorkflowFolders() {
  if (isLiveApi) return WorkflowFolderListSchema.parse(await apiGet("/api/v1/workflow-folders"))
  await delay(200)
  for (const workflow of mockWorkflows) workflow.folderEtag ??= mockPlacement(workflow.id).etag
  return { data: mockFolders.map(folder => ({ ...folder })), canEdit: true }
}
export async function createWorkflowFolder(name: string): Promise<WorkflowFolder> {
  const body = WorkflowFolderInputSchema.parse({ name })
  if (isLiveApi) return WorkflowFolderSchema.parse(await apiPost("/api/v1/workflow-folders", body, { idempotencyKey: mutationKey("folder-create") }))
  await delay(200)
  // Stable valid identities for this in-memory demo only.
  const id = `fld_00000000-0000-7000-8000-${(++mockId).toString(16).padStart(12, "0")}`
  const folder = { id, workspaceId: mockWorkspace, name: body.name, etag: `"folder-${id}-0"` }
  mockFolders.push(folder); return { ...folder }
}
export async function renameWorkflowFolder(folder: WorkflowFolder, name: string): Promise<WorkflowFolder> {
  const id = WorkflowFolderIdSchema.parse(folder.id), body = WorkflowFolderInputSchema.parse({ name })
  if (isLiveApi) return WorkflowFolderSchema.parse(await apiPatch(`/api/v1/workflow-folders/${id}`, body, { ifMatch: folder.etag, idempotencyKey: mutationKey("folder-rename") }))
  await delay(200)
  const index = mockFolders.findIndex(item => item.id === id)
  if (index < 0) throw new Error("Folder was not found")
  checkMatch(mockFolders[index].etag, folder.etag)
  const updated = { ...mockFolders[index], name: body.name, etag: `"folder-${id}-${Number(mockFolders[index].etag.match(/-(\d+)"$/)?.[1]) + 1}"` }
  mockFolders[index] = updated; return { ...updated }
}
export async function deleteWorkflowFolder(folder: WorkflowFolder): Promise<void> {
  const id = WorkflowFolderIdSchema.parse(folder.id)
  if (isLiveApi) return apiDelete(`/api/v1/workflow-folders/${id}`, { ifMatch: folder.etag, idempotencyKey: mutationKey("folder-delete") })
  await delay(200)
  const index = mockFolders.findIndex(item => item.id === id)
  if (index < 0) throw new Error("Folder was not found")
  checkMatch(mockFolders[index].etag, folder.etag)
  mockFolders.splice(index, 1)
  for (const workflow of mockWorkflows.filter(item => item.folderId === id)) { workflow.folderId = null; workflow.folderEtag = `"workflow-folder-${workflow.id}-${Number(workflow.folderEtag?.match(/-(\d+)"$/)?.[1] ?? 0) + 1}"` }
}
export async function moveWorkflowFolder(workflowId: string, folderId: string | null, etag: string): Promise<WorkflowFolderPlacement> {
  if (isLiveApi) WorkflowIdSchema.parse(workflowId)
  const body = WorkflowFolderMoveSchema.parse({ folderId })
  if (isLiveApi) return WorkflowFolderPlacementSchema.parse(await apiPut(`/api/v1/workflows/${encodeURIComponent(workflowId)}/folder`, body, { ifMatch: etag, idempotencyKey: mutationKey("workflow-move") }))
  await delay(200)
  if (folderId !== null && !mockFolders.some(folder => folder.id === folderId)) throw new Error("Folder was not found")
  const current = mockPlacement(workflowId); checkMatch(current.etag, etag)
  const workflow = mockWorkflows.find(item => item.id === workflowId)!
  workflow.folderId = folderId; workflow.folderEtag = `"workflow-folder-${workflowId}-${Number(current.etag.match(/-(\d+)"$/)?.[1] ?? 0) + 1}"`
  return mockPlacement(workflowId)
}
