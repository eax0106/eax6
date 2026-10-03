import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@/api/http", async original => ({ ...(await original<typeof import("@/api/http")>()), isLiveApi: true }))
import { MemorySettingsPage } from "./memory-settings"

const settings = { conversationMemoryEnabled: true, workflowMemoryEnabled: true, workspaceMemoryEnabled: true, retentionDays: 90, etag: '"memory-0"' }
const fetchMock = vi.fn<typeof fetch>()
const response = (value = settings) => Response.json(value, { headers: { etag: value.etag } })
function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemorySettingsPage /></QueryClientProvider>)
}
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(response()); vi.stubGlobal("fetch", fetchMock) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it("renders three labelled scopes and validates native retention before a live save", async () => {
  page()
  const days = await screen.findByLabelText("Retention days") as HTMLInputElement
  expect(days.value).toBe("90"); expect(days.min).toBe("7"); expect(days.max).toBe("365")
  expect(screen.getAllByRole("switch")).toHaveLength(3)
  for (const title of ["Chat memory", "Workflow memory", "Workspace memory"]) {
    const control = screen.getByLabelText(title)
    expect(control.getAttribute("aria-checked")).toBe("true")
    expect(document.getElementById(control.getAttribute("aria-describedby")!)?.textContent).toBeTruthy()
  }
  expect(screen.queryByText(/allow sensitive/i)).toBeNull()
  const save = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement
  for (const invalid of ["", "6", "366", "7.5"]) {
    fireEvent.change(days, { target: { value: invalid } }); expect(save.disabled).toBe(true); expect(days.getAttribute("aria-invalid")).toBe("true")
  }
  for (const valid of ["7", "365"]) { fireEvent.change(days, { target: { value: valid } }); expect(save.disabled).toBe(false) }
  await userEvent.click(screen.getByLabelText("Chat memory"))
  fetchMock.mockResolvedValueOnce(response({ ...settings, conversationMemoryEnabled: false, retentionDays: 365, etag: '"memory-1"' }))
  await userEvent.click(save); await screen.findByText("Memory settings saved.")
  const [url, init] = fetchMock.mock.calls[1]!
  expect(String(url)).toMatch(/\/api\/v1\/memory-settings$/); expect(init?.method).toBe("PUT")
  expect(new Headers(init?.headers).get("if-match")).toBe(settings.etag)
  expect(JSON.parse(String(init?.body))).toEqual({ conversationMemoryEnabled: false, workflowMemoryEnabled: true, workspaceMemoryEnabled: true, retentionDays: 365 })
})

it("retries a failed live read without showing demo values", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error_code: "UNAVAILABLE" }, { status: 503 }))
  page(); expect((await screen.findByRole("alert")).textContent).toContain("Could not load")
  expect(screen.queryByRole("switch")).toBeNull()
  await userEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect((await screen.findByLabelText("Retention days") as HTMLInputElement).value).toBe("90")
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it("reloads actual settings and ETag after a stale write", async () => {
  page(); await screen.findByLabelText("Retention days")
  fetchMock.mockResolvedValueOnce(Response.json({ error_code: "ETAG_MISMATCH" }, { status: 412 }))
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Settings changed")
  fetchMock.mockResolvedValueOnce(response({ ...settings, workflowMemoryEnabled: false, retentionDays: 30, etag: '"memory-1"' }))
  await userEvent.click(screen.getByRole("button", { name: "Reload settings" }))
  await waitFor(() => expect((screen.getByLabelText("Retention days") as HTMLInputElement).value).toBe("30"))
  expect(screen.getByLabelText("Workflow memory").getAttribute("aria-checked")).toBe("false")
  fetchMock.mockResolvedValueOnce(response({ ...settings, workflowMemoryEnabled: false, retentionDays: 30, etag: '"memory-2"' }))
  await userEvent.click(screen.getByRole("button", { name: "Save settings" })); await screen.findByText("Memory settings saved.")
  expect(new Headers(fetchMock.mock.calls[3]![1]?.headers).get("if-match")).toBe('"memory-1"')
})

it("keeps the edited values after a failed save and allows retry", async () => {
  page(); const days = await screen.findByLabelText("Retention days") as HTMLInputElement
  fireEvent.change(days, { target: { value: "7" } })
  fetchMock.mockRejectedValueOnce(new Error("Fixture transport unavailable"))
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Could not save")
  expect(days.value).toBe("7"); expect(screen.queryByText("Memory settings saved.")).toBeNull()
  fetchMock.mockResolvedValueOnce(response({ ...settings, retentionDays: 7, etag: '"memory-1"' }))
  await userEvent.click(screen.getByRole("button", { name: "Save settings" })); await screen.findByText("Memory settings saved.")
  expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).retentionDays).toBe(7)
})
