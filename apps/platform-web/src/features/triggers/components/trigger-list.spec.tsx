import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import { toast } from "sonner"
import type { Trigger } from "@/api/types"
import { TriggerList } from "./trigger-list"

vi.mock("@/api/client", () => ({
  api: {
    getTriggers: vi.fn(),
    testTrigger: vi.fn(),
    removeTrigger: vi.fn(),
    enableTrigger: vi.fn(),
    disableTrigger: vi.fn(),
    getHostedForm: vi.fn(),
    createHostedForm: vi.fn(),
    updateHostedForm: vi.fn(),
    setHostedFormStatus: vi.fn(),
    getWorkflowVersions: vi.fn(),
  },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const trigger: Trigger = {
  id: "trg_018f47a5-7b2c-7d10-8f11-123456789abc",
  workflowId: "wf_018f47a5-7b2c-7d10-8f11-123456789abc",
  type: "webhook",
  name: "Incoming order",
  enabled: true,
  status: "configured",
  config: {},
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TriggerList workflowId={trigger.workflowId} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getTriggers).mockResolvedValue([trigger])
  vi.mocked(api.removeTrigger).mockResolvedValue(undefined)
  vi.mocked(api.testTrigger).mockResolvedValue({ success: true, message: "Test event recorded.", eventId: "evt_1" })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe("trigger controls", () => {
  it("archives only after confirmation and reports success after the API call", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    renderList()

    await userEvent.click(await screen.findByRole("button", { name: "Remove Incoming order" }))

    await waitFor(() => expect(api.removeTrigger).toHaveBeenCalledWith(trigger.id))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Trigger removed"))
  })

  it("leaves the trigger alone when removal is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false)
    renderList()

    await userEvent.click(await screen.findByRole("button", { name: "Remove Incoming order" }))

    expect(api.removeTrigger).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("shows a failed test request as an error", async () => {
    vi.mocked(api.testTrigger).mockRejectedValue(new Error("Test event could not be recorded"))
    renderList()

    await userEvent.click(await screen.findByRole("button", { name: "Test" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Test event could not be recorded"))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

const definition = { title: "Lead form", fields: [{ name: "email", label: "Email", type: "email" as const, required: true }] }
const versionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abd"
const setup = { definition, publicUrl: "https://forms.example.com/f/current", triggerVersionId: "trv_018f47a5-7b2c-7d10-8f11-123456789abe", workflowVersionId: versionId, status: "enabled" as const, version: 1, etag: '"form-v1"' }

beforeEach(() => {
  vi.mocked(api.getWorkflowVersions).mockResolvedValue([{ id: versionId, version: 3, status: "compiled" } as never])
  vi.mocked(api.getHostedForm).mockResolvedValue(structuredClone(setup))
})

describe("hosted form setup controls", () => {
  it("starts with own source and creates nothing until hosted form is selected and saved", async () => {
    vi.mocked(api.getTriggers).mockResolvedValue([])
    vi.mocked(api.createHostedForm).mockResolvedValue({ ...trigger, provider: "alter_public_form" })
    renderList()
    await userEvent.click(await screen.findByRole("button", { name: "Add Trigger" }))
    expect((screen.getByRole("radio", { name: "Connect my own source" }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole("textbox", { name: "Form title" })).toBeNull()
    expect(api.createHostedForm).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("radio", { name: "Use an Alter hosted form" }))
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Workflow version" }), versionId)
    const title = screen.getByRole("textbox", { name: "Form title" })
    await userEvent.clear(title)
    await userEvent.type(title, "Customer inquiry")
    await userEvent.click(screen.getByRole("button", { name: "Create hosted form" }))
    await waitFor(() => expect(api.createHostedForm).toHaveBeenCalledWith(trigger.workflowId, versionId, expect.objectContaining({ title: "Customer inquiry", fields: [expect.objectContaining({ name: "email" })] })))
    expect((await screen.findByRole("link", { name: setup.publicUrl })).getAttribute("href")).toBe(setup.publicUrl)
  })
  it("keeps failed creation visible and never supplies a fabricated link", async () => {
    vi.mocked(api.createHostedForm).mockRejectedValue(new Error("Hosted forms are not configured"))
    renderList()
    await userEvent.click(await screen.findByRole("button", { name: "Add Trigger" }))
    await userEvent.click(screen.getByRole("radio", { name: "Use an Alter hosted form" }))
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Workflow version" }), versionId)
    await userEvent.click(screen.getByRole("button", { name: "Create hosted form" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Hosted forms are not configured")
    expect(screen.queryByRole("link", { name: setup.publicUrl })).toBeNull()
  })
  it("uses current definition and ETag, preserves refused edits, and reloads explicitly", async () => {
    vi.mocked(api.getTriggers).mockResolvedValue([{ ...trigger, provider: "alter_public_form" }])
    vi.mocked(api.updateHostedForm).mockRejectedValue(new Error("Form changed. Reload before saving."))
    renderList()
    await userEvent.click(await screen.findByRole("button", { name: "Settings for Incoming order" }))
    const title = await screen.findByRole("textbox", { name: "Form title" })
    await waitFor(() => expect((title as HTMLInputElement).value).toBe("Lead form"))
    await userEvent.clear(title)
    await userEvent.type(title, "Unsaved inquiry")
    await userEvent.click(screen.getByRole("button", { name: "Save form" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Form changed")
    expect((title as HTMLInputElement).value).toBe("Unsaved inquiry")
    expect(api.updateHostedForm).toHaveBeenCalledWith(trigger.id, { ...definition, title: "Unsaved inquiry" }, versionId, setup.etag)
    await userEvent.click(screen.getByRole("button", { name: "Reload form" }))
    await waitFor(() => expect((title as HTMLInputElement).value).toBe("Lead form"))
  })
  it("routes hosted enable/disable and archive through the current form version", async () => {
    vi.mocked(api.getTriggers).mockResolvedValue([{ ...trigger, provider: "alter_public_form" }])
    vi.mocked(api.setHostedFormStatus).mockResolvedValue({ ...trigger, enabled: false })
    vi.spyOn(window, "confirm").mockReturnValue(true)
    renderList()
    await userEvent.click(await screen.findByRole("button", { name: "Enabled" }))
    await waitFor(() => expect(api.setHostedFormStatus).toHaveBeenCalledWith(trigger.id, "disabled", setup.etag))
    expect(api.disableTrigger).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Remove Incoming order" }))
    await waitFor(() => expect(api.setHostedFormStatus).toHaveBeenCalledWith(trigger.id, "archived", setup.etag))
    expect(api.removeTrigger).not.toHaveBeenCalled()
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true)
  })
  it("remembers successful creation when fetching its link fails, so save cannot create another trigger", async () => {
    vi.mocked(api.createHostedForm).mockResolvedValue({ ...trigger, provider: "alter_public_form" })
    vi.mocked(api.getHostedForm).mockRejectedValue(new Error("Link unavailable"))
    renderList()
    await userEvent.click(await screen.findByRole("button", { name: "Add Trigger" }))
    await userEvent.click(screen.getByRole("radio", { name: "Use an Alter hosted form" }))
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Workflow version" }), versionId)
    await userEvent.click(screen.getByRole("button", { name: "Create hosted form" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Link unavailable")
    expect((screen.getByRole("button", { name: "Save form" }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.createHostedForm).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("link", { name: setup.publicUrl })).toBeNull()
  })
})
