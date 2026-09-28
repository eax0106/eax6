import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", () => ({
  apiGet: vi.fn(),
  apiGetWithEtag: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  mutationKey: (prefix: string) => `${prefix}-test-key`,
  isLiveApi: true,
}))

import { apiGet } from "./http"
import { globalSearchService } from "./services/global-search"

const workflows = {
  workflows: [
    { id: "wf_1", name: "Invoice Processing", description: "Extract data from invoices", status: "active" },
    { id: "wf_2", name: "Customer Support Triage", description: "Categorize tickets", status: "active" },
  ],
}
const projects = { projects: [{ id: "proj_1", name: "Invoice Portal", status: "building", brief: "Invoice self-service for finance" }] }
const knowledgeSources = { data: [{ id: "ks_1", provider: "google_drive", sync_config: { name: "Invoice Archive" } }] }
const connections = { data: [{ id: "conn_1", connector: "zendesk", status: "connected" }] }
const listings = { data: [{ kind: "listing", id: "lst_1", name: "Invoice Approval Automation", description: "Routes invoices for approval", rank: 0.9 }] }

// Each spotlight query reads several endpoints; route the fake by path so the
// real mapping code in live.ts runs over each payload.
function respond(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    const route = Object.keys(overrides).find((prefix) => path.startsWith(prefix))
    if (route) {
      const value = overrides[route]
      if (value instanceof Error) throw value
      return value as never
    }
    if (path.startsWith("/api/v1/search")) return listings as never
    // The engine searches names server-side (task B3.4); the fake does the same.
    const q = new URL(path, "http://x").searchParams.get("q")?.toLowerCase() ?? ""
    const byName = <T extends { name: string }>(items: T[]) => items.filter((item) => item.name.toLowerCase().includes(q))
    if (path.startsWith("/api/v1/workflows")) return { workflows: byName(workflows.workflows) } as never
    if (path.startsWith("/api/v1/projects")) return { projects: byName(projects.projects) } as never
    if (path.startsWith("/api/v1/ads/sources")) return knowledgeSources as never
    if (path.startsWith("/api/v1/integrations/connections")) return connections as never
    // The connector catalog, which is where a connection's display name comes
    // from; empty here, so a connection falls back to its connector id.
    if (path.startsWith("/api/v1/integrations")) return { data: [] } as never
    throw new Error(`unexpected path: ${path}`)
  })
}

// The service caches each list for ten seconds, so every test runs a minute
// further on than the last one and never reads another test's lists.
let clockOffsetMs = 0

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  clockOffsetMs += 60_000
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + clockOffsetMs)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("global search against the live API", () => {
  it("returns matching records from every searchable area, not a fixed list", async () => {
    respond()

    const results = await globalSearchService("invoice")

    expect(results).toEqual(
      expect.arrayContaining([
        { id: "lst_1", type: "marketplace_listing", title: "Invoice Approval Automation", description: "Routes invoices for approval", url: "/app/marketplace/listings/lst_1" },
        { id: "wf_1", type: "workflow", title: "Invoice Processing", description: "Extract data from invoices", url: "/app/workflows/wf_1" },
        { id: "proj_1", type: "project", title: "Invoice Portal", description: "Invoice self-service for finance", url: "/app/projects/proj_1" },
        { id: "ks_1", type: "knowledge_source", title: "Invoice Archive", description: "google_drive", url: "/app/knowledge/sources/ks_1" },
      ]),
    )
    // "Customer Support Triage" is real and does not match this query.
    expect(results.map((result) => result.id)).not.toContain("wf_2")
    expect(results.map((result) => result.id)).not.toContain("conn_1")
  })

  it("asks the Marketplace's own search endpoint for listings rather than filtering them here", async () => {
    respond()

    await globalSearchService("invoice")

    expect(vi.mocked(apiGet).mock.calls.map(([path]) => path)).toContainEqual(
      "/api/v1/search?q=invoice&kind=listing&limit=5",
    )
  })

  it("asks the engine to search workflow and project names instead of filtering one page here", async () => {
    respond()

    await globalSearchService("  invoice ")

    const paths = vi.mocked(apiGet).mock.calls.map(([path]) => path)
    expect(paths).toContainEqual("/api/v1/workflows?q=invoice&limit=5")
    expect(paths).toContainEqual("/api/v1/projects?q=invoice&limit=5")
  })

  it("still shows the other areas when one of them is refused", async () => {
    respond({ "/api/v1/integrations/connections": new Error("403 Forbidden") })

    const results = await globalSearchService("invoice")

    expect(results.map((result) => result.id)).not.toContain("conn_1")
    expect(results.map((result) => result.id)).toEqual(expect.arrayContaining(["wf_1", "proj_1", "ks_1", "lst_1"]))
  })

  it("finds a connection by the connector it uses", async () => {
    respond()

    expect(await globalSearchService("zendesk")).toContainEqual({
      id: "conn_1",
      type: "connection",
      title: "zendesk",
      description: "connected",
      url: "/app/connections/conn_1",
    })
  })

  it("returns nothing for an empty query without calling the API", async () => {
    respond()

    expect(await globalSearchService("")).toEqual([])
    expect(apiGet).not.toHaveBeenCalled()
  })
})
