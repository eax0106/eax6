import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, waitFor, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DataControlsPage } from "./data-controls"

vi.mock("@/api/http", async (importOriginal) => ({ ...await importOriginal<typeof import("@/api/http")>(), isLiveApi: true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const workspaces = [{ id: "ws_1", name: "W", slug: "w" }]
const readyExport = {
  id: "exp_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  workspace_id: "ws_1",
  status: "ready",
  failure_reason: null,
  requested_at: "2026-09-30T10:00:00.000Z",
  updated_at: "2026-09-30T10:05:00.000Z",
  expires_at: "2026-10-07T10:05:00.000Z",
}
const failedExport = { ...readyExport, id: "exp_018f4d6e-2b4a-7a3e-8c1a-1234567890ac", status: "failed", failure_reason: "ads down" }

function stubFetch(impl: (url: string) => unknown) {
  const request = vi.fn<typeof fetch>().mockImplementation(async (input) => Response.json(impl(String(input))))
  vi.stubGlobal("fetch", request)
  return request
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><DataControlsPage /></QueryClientProvider>)
}

beforeEach(() => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() })
})

it("renders ready and failed exports and hides the mock deletion card in live mode", async () => {
  stubFetch((url) =>
    url.endsWith("/api/v1/workspaces") ? workspaces : url.includes("/exports") ? [readyExport, failedExport] : [],
  )
  renderPage()
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined())
  expect(screen.getByText("Failed")).toBeDefined()
  expect(screen.getByText("ads down")).toBeDefined()
  expect(screen.getByText("Download")).toBeDefined()
  expect(screen.queryByText("Delete All Workspace Data")).toBeNull()
  expect(screen.queryByText(/emailed to you/)).toBeNull()
})

it("requests an export and refreshes the list", async () => {
  const seen: string[] = []
  const request = stubFetch((url) => {
    seen.push(url)
    if (url.endsWith("/api/v1/workspaces")) return workspaces
    if (url.includes("/exports") && !url.endsWith("/exports")) return []
    return [{ ...readyExport, status: "requested" }]
  })
  const user = userEvent.setup()
  renderPage()
  await waitFor(() => expect(screen.getByText("Request Data Export")).toBeDefined())
  request.mockClear()
  await user.click(screen.getByText("Request Data Export"))
  await waitFor(() => expect(request.mock.calls.some(([url]) => String(url).includes("/api/v1/workspaces/ws_1/exports"))).toBe(true))
  const post = request.mock.calls.find(([url, init]) => String(url).endsWith("/exports") && (init as RequestInit).method === "POST")
  expect(post).toBeDefined()
})

it("downloads a ready archive as a JSON file", async () => {
  stubFetch((url) => {
    if (url.endsWith("/api/v1/workspaces")) return workspaces
    if (url.endsWith("/download")) return { exported_at: "2026-09-30T10:05:00.000Z", workspace_id: "ws_1", workflows: [], workflowVersions: [], runs: [], knowledgeSources: [], knowledgeDocuments: [], members: [] }
    return [readyExport]
  })
  const user = userEvent.setup()
  const downloads: string[] = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
  renderPage()
  await waitFor(() => expect(screen.getByText("Download")).toBeDefined())
  await user.click(screen.getByText("Download"))
  await waitFor(() => expect(downloads).toHaveLength(1))
  expect(downloads[0]).toContain("workspace-export-")
  click.mockRestore()
})

it("shows unavailable instead of no exports when a live list is malformed", async () => {
  stubFetch((url) => url.endsWith("/api/v1/workspaces") ? workspaces : { malformed: true })
  renderPage()
  await waitFor(() => expect(screen.getByText("Exports unavailable. Try again.")).toBeDefined())
  expect(screen.queryByText("No exports yet. Request one below.")).toBeNull()
})

it("does not download an incomplete archive", async () => {
  stubFetch((url) => {
    if (url.endsWith("/api/v1/workspaces")) return workspaces
    if (url.endsWith("/download")) return { exported_at: "2026-09-30T10:05:00.000Z", workspace_id: "ws_1", workflows: [] }
    return [readyExport]
  })
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
  renderPage()
  await waitFor(() => expect(screen.getByText("Download")).toBeDefined())
  await userEvent.setup().click(screen.getByText("Download"))
  await waitFor(() => expect(screen.getByText(/Download failed/)).toBeDefined())
  expect(click).not.toHaveBeenCalled()
  click.mockRestore()
})

it("reads exports for the selected real workspace", async () => {
  const request = stubFetch((url) => {
    if (url.endsWith("/api/v1/workspaces")) return [...workspaces, { id: "ws_2", name: "Second", slug: "second" }]
    return [{ ...readyExport, workspace_id: url.includes("/workspaces/ws_2/") ? "ws_2" : "ws_1" }]
  })
  renderPage()
  await waitFor(() => expect(screen.getByLabelText("Export workspace")).toBeDefined())
  await userEvent.setup().selectOptions(screen.getByLabelText("Export workspace"), "ws_2")
  await waitFor(() => expect(request.mock.calls.some(([url]) => String(url).includes("/workspaces/ws_2/exports"))).toBe(true))
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined())
})
