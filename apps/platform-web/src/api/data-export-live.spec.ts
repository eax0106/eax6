import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { downloadDataExport, getDataExport, listDataExports, requestDataExport } from "./live-data-export"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const apiExport = {
  id: "exp_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  workspace_id: "ws_1",
  status: "ready",
  failure_reason: null,
  requested_at: "2026-09-30T10:00:00.000Z",
  updated_at: "2026-09-30T10:05:00.000Z",
  expires_at: "2026-10-07T10:05:00.000Z",
}

describe("live data exports (D2, durable platform-api records)", () => {
  it("lists a workspace's exports from its own route", async () => {
    fetchMock.mockImplementation(async () => Response.json([apiExport]))
    const [item] = await listDataExports("ws_1")
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/workspaces/ws_1/exports")
    expect(item).toMatchObject({ id: apiExport.id, workspaceId: "ws_1", status: "ready", failureReason: null })
  })

  it("requests with an empty strict body and an idempotency key", async () => {
    fetchMock.mockImplementation(async () => Response.json({ ...apiExport, status: "requested" }, { status: 201 }))
    const created = await requestDataExport("ws_1")
    expect(created.status).toBe("requested")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/workspaces/ws_1/exports")
    expect(JSON.parse(String(init!.body))).toEqual({})
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^data-export-create/)
  })

  it("reads one record and downloads the archive envelope", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json(apiExport))
    expect((await getDataExport("ws_1", apiExport.id)).status).toBe("ready")
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ exported_at: "2026-09-30T10:05:00.000Z", workspace_id: "ws_1", workflows: [{ id: "wf_1" }], runs: [], members: [] }),
    )
    const archive = await downloadDataExport("ws_1", apiExport.id)
    expect(String(fetchMock.mock.calls[1]![0])).toContain(`/api/v1/workspaces/ws_1/exports/${apiExport.id}/download`)
    expect(archive.workspaceId).toBe("ws_1")
    expect(archive.workflows).toHaveLength(1)
  })

  it("maps an unknown status to requested rather than inventing one", async () => {
    fetchMock.mockImplementation(async () => Response.json([{ ...apiExport, status: "mystery" }]))
    const [item] = await listDataExports("ws_1")
    expect(item!.status).toBe("requested")
  })
})
