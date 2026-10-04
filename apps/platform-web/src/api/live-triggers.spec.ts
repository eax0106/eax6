import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", () => ({
  apiGet: vi.fn(),
  apiGetWithEtag: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  mutationKey: (prefix: string) => `${prefix}-test-key`,
}))

import { apiGet, apiGetWithEtag, apiPatch, apiPost } from "./http"
import { disableTrigger, getTriggers, removeTrigger, testTrigger, getHostedForm, createHostedForm, updateHostedForm, setHostedFormStatus } from "./live"

const triggerId = "trg_018f47a5-7b2c-7d10-8f11-123456789abc"
const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc"
const trigger = {
  id: triggerId,
  workflowId,
  name: "Daily digest",
  type: "cron",
  status: "enabled",
  provider: null,
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiGetWithEtag).mockReset()
  vi.mocked(apiPatch).mockReset()
  vi.mocked(apiPost).mockReset()
  vi.mocked(apiGetWithEtag).mockResolvedValue({ data: trigger, etag: '"trigger-v1"' })
  vi.mocked(apiPatch).mockResolvedValue({ ...trigger, status: "archived" })
})

describe("live trigger management", () => {
  it("shows current triggers with the engine's status and type mapped for the UI", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      triggers: [trigger, { ...trigger, id: "trg_archived", status: "archived" }],
    })

    expect(await getTriggers(workflowId)).toMatchObject([
      { id: triggerId, type: "schedule", status: "configured", enabled: true },
    ])
  })

  it("reports a test only after the backend returns a recorded event", async () => {
    vi.mocked(apiPost).mockResolvedValue({ eventId: "evt_123", triggerId, triggerVersion: 2 })

    expect(await testTrigger(triggerId)).toEqual({
      success: true,
      message: "Test event recorded.",
      eventId: "evt_123",
    })
    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/triggers/${triggerId}/actions/test`,
      {},
      { idempotencyKey: "trigger-test-test-key" },
    )
  })

  it("does not claim success when the test response has no event id", async () => {
    vi.mocked(apiPost).mockResolvedValue({})
    await expect(testTrigger(triggerId)).rejects.toThrow("No test event was returned")
  })

  it("archives a trigger through the real status route with the server ETag", async () => {
    await removeTrigger(triggerId)

    expect(apiGetWithEtag).toHaveBeenCalledWith(`/api/v1/triggers/${triggerId}`)
    expect(apiPatch).toHaveBeenCalledWith(
      `/api/v1/triggers/${triggerId}/status`,
      { status: "archived" },
      { idempotencyKey: "trigger-status-test-key", ifMatch: '"trigger-v1"' },
    )
  })

  it("refuses a status change without the server ETag", async () => {
    vi.mocked(apiGetWithEtag).mockResolvedValue({ data: trigger, etag: undefined })

    await expect(removeTrigger(triggerId)).rejects.toThrow("Trigger ETag missing")
    expect(apiPatch).not.toHaveBeenCalled()
  })

  it("disables a trigger using the same real status route", async () => {
    vi.mocked(apiPatch).mockResolvedValue({ ...trigger, status: "disabled" })

    expect(await disableTrigger(triggerId)).toMatchObject({ enabled: false, status: "configured" })
    expect(apiPatch).toHaveBeenCalledWith(
      `/api/v1/triggers/${triggerId}/status`,
      { status: "disabled" },
      { idempotencyKey: "trigger-status-test-key", ifMatch: '"trigger-v1"' },
    )
  })
})

const definition = { title: "Lead form", fields: [{ name: "email", label: "Email", type: "email" as const, required: true }] }
const versionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc"
const setup = { definition, publicUrl: "https://forms.example.com/f/opaque", triggerVersionId: "trv_018f47a5-7b2c-7d10-8f11-123456789abd", workflowVersionId: versionId, status: "draft", version: 1, etag: '"form-v1"' }

describe("live hosted form authoring", () => {
  it("uses the workflow's real workspace and explicitly selects the hosted provider", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ workspaceId: "018f47a5-7b2c-7d10-8f11-123456789abe" }).mockResolvedValueOnce(setup)
    vi.mocked(apiPost).mockResolvedValue({ trigger: { ...trigger, type: "webhook", provider: "alter_public_form", status: "draft" } })
    expect(await createHostedForm(workflowId, versionId, definition)).toMatchObject({ provider: "alter_public_form", enabled: false })
    expect(apiPost).toHaveBeenCalledWith("/api/v1/triggers", { workflowId, workflowVersionId: versionId, workspaceId: "ws_018f47a5-7b2c-7d10-8f11-123456789abe", name: "Lead form", type: "webhook", provider: "alter_public_form", config: { publicForm: definition } }, { idempotencyKey: "hosted-form-create-test-key" })
  })
  it("refuses missing workspace or malformed current form instead of manufacturing a link", async () => {
    vi.mocked(apiGet).mockResolvedValue({})
    await expect(createHostedForm(workflowId, versionId, definition)).rejects.toThrow()
    expect(apiPost).not.toHaveBeenCalled()
    await expect(getHostedForm(triggerId)).rejects.toThrow()
  })
  it("edits an immutable version with its displayed ETag and returns the server's new link", async () => {
    vi.mocked(apiGet).mockResolvedValue(setup)
    expect(await updateHostedForm(triggerId, definition, versionId, setup.etag)).toEqual(setup)
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/triggers/${triggerId}/versions`, { workflowVersionId: versionId, config: { publicForm: definition } }, { idempotencyKey: "hosted-form-edit-test-key", ifMatch: setup.etag })
  })
  it("keeps stale edits and refused status writes failed without fetching a success link", async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error("Form changed"))
    await expect(updateHostedForm(triggerId, definition, versionId, setup.etag)).rejects.toThrow("Form changed")
    expect(apiGet).not.toHaveBeenCalled()
    vi.mocked(apiPatch).mockRejectedValue(new Error("Permission denied"))
    await expect(setHostedFormStatus(triggerId, "enabled", setup.etag)).rejects.toThrow("Permission denied")
    expect(apiPatch).toHaveBeenCalledWith(`/api/v1/triggers/${triggerId}/public-form/status`, { status: "enabled" }, { idempotencyKey: "hosted-form-status-test-key", ifMatch: setup.etag })
  })
})
