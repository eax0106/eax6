import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { deleteWorkspace, getPendingDeletionWorkspaces, restoreWorkspace } from "./live"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const id = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab"

describe("live workspace pending deletion (D2)", () => {
  it("deletes with the typed name in the body and returns the restore deadline", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ id, name: "Marketing", status: "pending_deletion", deletionDueAt: "2026-10-08T10:00:00.000Z" }),
    )
    await expect(deleteWorkspace(id, "Marketing")).resolves.toEqual({ deletionDueAt: "2026-10-08T10:00:00.000Z" })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain(`/api/v1/workspaces/${id}`)
    expect(init!.method).toBe("DELETE")
    expect(JSON.parse(String(init!.body))).toEqual({ confirm_name: "Marketing" })
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^workspace-delete/)
  })

  it("surfaces a name mismatch as an error instead of succeeding", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ title: "WORKSPACE_CONFIRM_NAME_MISMATCH", status: 400, detail: "Type the workspace name exactly" }, { status: 400 }),
    )
    await expect(deleteWorkspace(id, "marketing")).rejects.toMatchObject({ status: 400 })
  })

  it("lists pending workspaces and restores one", async () => {
    fetchMock.mockImplementationOnce(async () =>
      Response.json([{ id, name: "Marketing", status: "pending_deletion", deletionDueAt: "2026-10-08T10:00:00.000Z" }]),
    )
    await expect(getPendingDeletionWorkspaces()).resolves.toEqual([
      { id, name: "Marketing", deletionDueAt: "2026-10-08T10:00:00.000Z" },
    ])
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/workspaces/pending-deletion")

    fetchMock.mockImplementationOnce(async () => Response.json({ id, status: "active" }))
    await restoreWorkspace(id)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain(`/api/v1/workspaces/${id}/actions/restore`)
    expect(init!.method).toBe("POST")
  })
})
