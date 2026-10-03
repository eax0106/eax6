import { afterEach, beforeEach, expect, it, vi } from "vitest"

const folder = { id: "fld_019a1b2c-3d4e-7f50-8a61-72839405a6b1", workspaceId: "ws_019a1b2c-3d4e-7f50-8a61-72839405a6b2", name: "Finance", etag: '"folder-fld_019a1b2c-3d4e-7f50-8a61-72839405a6b1-3"' }
const workflowId = "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b3"
const placement = { workflowId, folderId: folder.id, etag: `"workflow-folder-${workflowId}-2"` }

beforeEach(() => { vi.resetModules(); vi.stubEnv("VITE_API_MODE", "live"); vi.stubGlobal("fetch", vi.fn()) })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
function respond(body: unknown, status = 200) { vi.mocked(fetch).mockResolvedValueOnce(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) }

it("uses the live collection and exact pinned preconditions for each folder mutation", async () => {
  const folders = await import("./workflow-folders")
  respond({ data: [folder], canEdit: false }); expect(await folders.getWorkflowFolders()).toEqual({ data: [folder], canEdit: false })
  respond(folder, 201); await folders.createWorkflowFolder(" Finance ")
  respond({ ...folder, name: "Invoices" }); await folders.renameWorkflowFolder(folder, "Invoices")
  respond(placement); await folders.moveWorkflowFolder(workflowId, folder.id, placement.etag)
  respond({ ...placement, folderId: null }); await folders.moveWorkflowFolder(workflowId, null, placement.etag)
  respond(undefined, 204); await folders.deleteWorkflowFolder(folder)
  const calls = vi.mocked(fetch).mock.calls.map(([path, init]) => ({ path, method: init?.method, body: init?.body && JSON.parse(String(init.body)), headers: new Headers(init?.headers), credentials: init?.credentials }))
  expect(calls.map(call => [call.path, call.method])).toEqual([
    ["/api/v1/workflow-folders", "GET"], ["/api/v1/workflow-folders", "POST"], [`/api/v1/workflow-folders/${folder.id}`, "PATCH"],
    [`/api/v1/workflows/${workflowId}/folder`, "PUT"], [`/api/v1/workflows/${workflowId}/folder`, "PUT"], [`/api/v1/workflow-folders/${folder.id}`, "DELETE"],
  ])
  expect(calls[1].body).toEqual({ name: "Finance" }); expect(calls[2].body).toEqual({ name: "Invoices" })
  expect(calls[3].body).toEqual({ folderId: folder.id }); expect(calls[4].body).toEqual({ folderId: null })
  expect(calls[2].headers.get("If-Match")).toBe(folder.etag); expect(calls[5].headers.get("If-Match")).toBe(folder.etag)
  expect(calls[3].headers.get("If-Match")).toBe(placement.etag)
  expect(calls.every(call => call.credentials === "include")).toBe(true)
  expect(calls.slice(1).every(call => Boolean(call.headers.get("Idempotency-Key")))).toBe(true)
})

it("rejects malformed identities and resources, and surfaces stale or failed live requests", async () => {
  const folders = await import("./workflow-folders")
  await expect(folders.createWorkflowFolder(" ")).rejects.toThrow()
  await expect(folders.moveWorkflowFolder("not-a-workflow", null, placement.etag)).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  respond({ data: [{ ...folder, id: "bad" }], canEdit: true }); await expect(folders.getWorkflowFolders()).rejects.toThrow()
  respond({ message: "Reload resource", error_code: "PRECONDITION_FAILED" }, 412)
  await expect(folders.renameWorkflowFolder(folder, "Edited name")).rejects.toMatchObject({ status: 412 })
  respond({ message: "Unavailable" }, 503); await expect(folders.getWorkflowFolders()).rejects.toMatchObject({ status: 503 })
})

it("loads every actual workspace workflow page and validates returned folder placement", async () => {
  const { getWorkflows } = await import("./live")
  respond({ data: [{ id: workflowId, name: "First", folderId: folder.id, folderEtag: placement.etag }], page: { has_more: true, next_cursor: "next/page" } })
  respond({ data: [{ id: workflowId, name: "Second", folderId: null, folderEtag: placement.etag }], page: { has_more: false } })
  expect(await getWorkflows()).toEqual([expect.objectContaining({ name: "First", folderId: folder.id, folderEtag: placement.etag }), expect.objectContaining({ name: "Second", folderId: null })])
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/workflows?limit=200&cursor=next%2Fpage", expect.anything())
  respond({ data: [{ id: workflowId, folderId: "bad", folderEtag: placement.etag }] }); await expect(getWorkflows()).rejects.toThrow()
})

it("never treats an incomplete or repeating page sequence as complete workflow context", async () => {
  const { getWorkflows } = await import("./live")
  respond({ data: [], page: { has_more: true } }); await expect(getWorkflows()).rejects.toThrow("Workflow pagination could not continue")
  for (let index = 0; index < 2; index++) respond({ data: [], page: { has_more: true, next_cursor: "same" } })
  await expect(getWorkflows()).rejects.toThrow("Workflow pagination could not continue")
})

it("mirrors folder placement and stale writes for the existing mock workflows", async () => {
  vi.stubEnv("VITE_API_MODE", "mock")
  const folders = await import("./workflow-folders"), { mockWorkflows } = await import("./mock/data")
  const workflow = mockWorkflows[0], before = { ...workflow }
  try {
    await folders.getWorkflowFolders()
    const created = await folders.createWorkflowFolder("Demo folder")
    const firstEtag = workflow.folderEtag!
    const moved = await folders.moveWorkflowFolder(workflow.id, created.id, firstEtag)
    expect(workflow.folderId).toBe(created.id); expect(moved.etag).not.toBe(firstEtag)
    await expect(folders.moveWorkflowFolder(workflow.id, null, firstEtag)).rejects.toMatchObject({ status: 412 })
    await folders.deleteWorkflowFolder(created)
    expect(workflow.folderId).toBeNull(); expect(mockWorkflows[0].id).toBe(before.id)
    expect(fetch).not.toHaveBeenCalled()
  } finally { Object.assign(workflow, before); if (before.folderId === undefined) delete workflow.folderId; if (before.folderEtag === undefined) delete workflow.folderEtag }
})
