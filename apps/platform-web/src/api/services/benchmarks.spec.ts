import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mode = vi.hoisted(() => ({ live: true }))
vi.mock("../http", async original => ({ ...await original<typeof import("../http")>(), get isLiveApi() { return mode.live } }))
vi.mock("../mock/data", async original => ({ ...await original<typeof import("../mock/data")>(), delay: async () => undefined }))
import { benchmarksService } from "./benchmarks"

const fetcher = vi.fn<typeof fetch>()
beforeEach(() => { mode.live = true; fetcher.mockReset(); vi.stubGlobal("fetch", fetcher) })
afterEach(() => vi.unstubAllGlobals())

function call(index = 0) {
  const [url, init] = fetcher.mock.calls[index]!
  return { url: new URL(String(url), "http://app.test"), init: init! }
}

describe("benchmarks adapter", () => {
  it("reads datasets, runs and details over authenticated live HTTP", async () => {
    fetcher.mockImplementation(async () => Response.json({ data: [] }))
    await benchmarksService.listDatasets()
    await benchmarksService.listRuns("ds 1")
    await benchmarksService.listRuns()
    expect(call(0).url.pathname).toBe("/api/v1/benchmarks/datasets")
    expect(call(0).init.credentials).toBe("include")
    expect(Object.fromEntries(call(1).url.searchParams)).toEqual({ limit: "50", datasetId: "ds 1" })
    expect(Object.fromEntries(call(2).url.searchParams)).toEqual({ limit: "50" })
    fetcher.mockImplementation(async () => Response.json({ id: "x" }))
    await benchmarksService.getDataset("a/b")
    await benchmarksService.getRun("r/1")
    expect(call(3).url.pathname).toBe("/api/v1/benchmarks/datasets/a%2Fb")
    expect(call(4).url.pathname).toBe("/api/v1/benchmarks/runs/r%2F1")
  })

  it("creates datasets and starts runs with an idempotency key", async () => {
    fetcher.mockImplementation(async () => Response.json({ id: "x" }))
    const dataset = { name: "Leads", description: "", cases: [{ input: { a: 1 }, successCriteria: ["ok"] }] }
    await benchmarksService.createDataset(dataset)
    await benchmarksService.startRun("ds1", "wf_1")
    expect(call(0).init.method).toBe("POST")
    expect(JSON.parse(String(call(0).init.body))).toEqual(dataset)
    expect(new Headers(call(0).init.headers).get("Idempotency-Key")).toMatch(/^benchmark-dataset-/)
    expect(call(1).url.pathname).toBe("/api/v1/benchmarks/datasets/ds1/runs")
    expect(JSON.parse(String(call(1).init.body))).toEqual({ workflowId: "wf_1" })
    expect(new Headers(call(1).init.headers).get("Idempotency-Key")).toMatch(/^benchmark-run-/)
  })

  it("keeps demo datasets in memory and never invents a verdict", async () => {
    mode.live = false
    const created = await benchmarksService.createDataset({ name: " Demo ", description: "", cases: [{ input: {}, successCriteria: ["ok"] }] })
    expect(created).toMatchObject({ name: "Demo", caseCount: 1 })
    await expect(benchmarksService.createDataset({ name: "Demo", description: "", cases: [{ input: {}, successCriteria: ["ok"] }] }))
      .rejects.toThrow("already exists")
    expect((await benchmarksService.listDatasets()).map(item => item.id)).toContain(created.id)
    expect(await benchmarksService.getDataset(created.id)).toEqual(created)
    const run = await benchmarksService.startRun(created.id, "wf_demo")
    expect(run).toMatchObject({ passed: 0, errored: 1, results: [{ verdict: "error", error: "Demo mode does not run workflows" }] })
    expect((await benchmarksService.listRuns(created.id)).map(item => item.id)).toEqual([run.id])
    expect(await benchmarksService.getRun(run.id)).toEqual(run)
    await expect(benchmarksService.getRun("missing")).rejects.toThrow("not found")
    await expect(benchmarksService.getDataset("missing")).rejects.toThrow("not found")
    expect(fetcher).not.toHaveBeenCalled()
  })
})
