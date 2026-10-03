import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WorkflowFolder } from "@alterx/contracts"
import { api } from "@/api/client"
import { ApiHttpError } from "@/api/http"
import { WorkflowFolderManager } from "./workflow-folder-manager"
import { WorkflowFolderSidebar } from "./workflow-folder-sidebar"
import { WorkflowsList } from "../pages"

vi.mock("@/features/permissions/components/require-permission", () => ({ RequirePermission: ({ children }: { children: React.ReactNode }) => children }))
const folder: WorkflowFolder = { id: "fld_019a1b2c-3d4e-7f50-8a61-72839405a6b1", workspaceId: "ws_019a1b2c-3d4e-7f50-8a61-72839405a6b2", name: "Finance", etag: '"folder-fld_019a1b2c-3d4e-7f50-8a61-72839405a6b1-3"' }
const workflowId = "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b3", placementEtag = `"workflow-folder-${workflowId}-2"`
const workflow = { id: workflowId, name: "Invoice checks", status: "draft" as const, runs: 3, successRate: 100, updatedAt: "2026-10-03", folderId: folder.id, folderEtag: placementEtag }
let rows: WorkflowFolder[]
beforeEach(() => {
  vi.restoreAllMocks(); rows = [{ ...folder }]
  vi.spyOn(api, "getWorkflowFolders").mockImplementation(async () => ({ data: rows, canEdit: true }))
  vi.spyOn(api, "getWorkflows").mockResolvedValue([workflow, { ...workflow, id: "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b4", name: "Ungrouped report", folderId: null }])
})
afterEach(cleanup)
function show(element: React.ReactNode, path = "/app/workflows") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{element}</MemoryRouter></QueryClientProvider>)
}

it("creates, renames with the displayed ETag and confirms deletion without deleting workflows", async () => {
  const create = vi.spyOn(api, "createWorkflowFolder").mockImplementation(async name => { const made = { ...folder, name }; rows = [made]; return made })
  const rename = vi.spyOn(api, "renameWorkflowFolder").mockImplementation(async (current, name) => { const changed = { ...current, name, etag: current.etag.replace("-3", "-4") }; rows = [changed]; return changed })
  const remove = vi.spyOn(api, "deleteWorkflowFolder").mockImplementation(async () => { rows = [] })
  show(<WorkflowFolderManager />)
  await userEvent.type(await screen.findByRole("textbox", { name: "New folder name" }), "Reports")
  await userEvent.click(screen.getByRole("button", { name: "Create folder" })); await screen.findByRole("button", { name: "Rename Reports" })
  expect(create).toHaveBeenCalledWith("Reports")
  await userEvent.click(screen.getByRole("button", { name: "Rename Reports" }))
  const name = screen.getByRole("textbox", { name: "Folder name" }); await userEvent.clear(name); await userEvent.type(name, "Audits")
  await userEvent.click(screen.getByRole("button", { name: "Save folder name" })); await screen.findByRole("button", { name: "Delete Audits" })
  expect(rename).toHaveBeenCalledWith({ ...folder, name: "Reports" }, "Audits")
  await userEvent.click(screen.getByRole("button", { name: "Delete Audits" }))
  expect(remove).not.toHaveBeenCalled(); expect(screen.getByText(/workflows return to Ungrouped/).textContent).toContain("chats and runs remain")
  await userEvent.click(screen.getByRole("button", { name: "Confirm delete folder" }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "Audits", etag: folder.etag.replace("-3", "-4") })))
  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete Audits" })).toBeNull())
  expect(screen.getByRole("link", { name: "Ungrouped" })).toBeDefined()
})

it("retains a stale rename and failed reload, then uses only freshly loaded folder state", async () => {
  const rename = vi.spyOn(api, "renameWorkflowFolder").mockRejectedValue(new ApiHttpError({ code: "PRECONDITION_FAILED", message: "Stale" }, 412))
  show(<WorkflowFolderManager />); await userEvent.click(await screen.findByRole("button", { name: "Rename Finance" }))
  const name = screen.getByRole("textbox", { name: "Folder name" }); await userEvent.clear(name); await userEvent.type(name, "My retained edit")
  await userEvent.click(screen.getByRole("button", { name: "Save folder name" })); await screen.findByText(/Folders changed/)
  expect((name as HTMLInputElement).value).toBe("My retained edit"); expect(rename).toHaveBeenCalledTimes(1)
  vi.mocked(api.getWorkflowFolders).mockRejectedValueOnce(new Error("Reload unavailable"))
  await userEvent.click(screen.getByRole("button", { name: "Reload folders" })); await screen.findByRole("button", { name: "Retry folders" })
  await userEvent.click(screen.getByRole("button", { name: "Retry folders" })); await screen.findByRole("textbox", { name: "Folder name" })
  expect((screen.getByRole("textbox", { name: "Folder name" }) as HTMLInputElement).value).toBe("My retained edit")
  rows = [{ ...folder, name: "Fresh folder", etag: folder.etag.replace("-3", "-5") }]
  await userEvent.click(screen.getByRole("button", { name: "Reload folders" })); await screen.findByRole("button", { name: "Rename Fresh folder" })
  expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull()
})

it("keeps readable grouping for viewers and exposes no folder write controls", async () => {
  vi.mocked(api.getWorkflowFolders).mockResolvedValue({ data: [folder], canEdit: false })
  show(<><WorkflowFolderManager /><WorkflowFolderSidebar /></>)
  const nav = await screen.findByRole("navigation", { name: "Workflow folders" })
  expect(within(nav).getByRole("link", { name: "Finance" }).getAttribute("href")).toBe(`/app/workflows?folder=${folder.id}`)
  const grouped = within(nav).getByRole("link", { name: "Invoice checks" }).closest("details")!
  expect(within(grouped).getByRole("link", { name: "Finance" })).toBeDefined()
  expect(within(nav).getByRole("link", { name: "Ungrouped report" }).closest("details")?.textContent).toContain("Ungrouped")
  expect(screen.queryByRole("button", { name: "Create folder" })).toBeNull(); expect(screen.queryByRole("button", { name: "Rename Finance" })).toBeNull()
})

it("shows a failed folder read and retries without fabricating an empty collection", async () => {
  vi.mocked(api.getWorkflowFolders).mockRejectedValueOnce(new Error("Unavailable"))
  show(<WorkflowFolderSidebar />); await screen.findByRole("alert")
  expect(screen.queryByRole("link", { name: "Ungrouped" })).toBeNull()
  await userEvent.click(screen.getByRole("button", { name: "Retry folders" })); await screen.findByRole("link", { name: "Finance" })
})

it("filters by the selected folder and moves using its actual workflow precondition", async () => {
  let finish: (() => void) | undefined
  const move = vi.spyOn(api, "moveWorkflowFolder").mockImplementation(() => new Promise(resolve => { finish = () => resolve({ workflowId, folderId: null, etag: placementEtag }) }))
  show(<WorkflowsList />, `/app/workflows?folder=${folder.id}`)
  const select = await screen.findByRole("combobox", { name: "Folder for Invoice checks" })
  expect(screen.queryByText("Ungrouped report")).toBeNull()
  await userEvent.selectOptions(select, ""); expect(move).toHaveBeenCalledWith(workflowId, null, placementEtag)
  expect((select as HTMLSelectElement).disabled).toBe(true); finish!()
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false))
  await userEvent.click(screen.getByRole("button", { name: "Show all workflows" })); await screen.findByText("Ungrouped report")
})

it("keeps the original folder after a failed move and requires reload after a stale response", async () => {
  vi.spyOn(api, "moveWorkflowFolder").mockRejectedValue(new ApiHttpError({ code: "PRECONDITION_FAILED", message: "Stale" }, 412))
  show(<WorkflowsList />)
  const select = await screen.findByRole("combobox", { name: "Folder for Invoice checks" }); await userEvent.selectOptions(select, "")
  await screen.findByText(/Workflow folder changed/); expect((select as HTMLSelectElement).value).toBe(folder.id)
  expect(screen.getByRole("button", { name: "Reload workflows" })).toBeDefined()
})
