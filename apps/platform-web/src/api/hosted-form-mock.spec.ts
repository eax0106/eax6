import { expect, it, vi } from "vitest"
import { HostedFormSetupSchema } from "@alterx/contracts"
vi.mock("./http", async importOriginal => ({ ...await importOriginal<object>(), isLiveApi: false }))
vi.mock("./mock/data", async importOriginal => ({ ...await importOriginal<object>(), delay: async () => {} }))
import { api } from "./client"

it("persists mock form fields and bindings, rotates links, rejects stale edits and archives explicitly", async () => {
  const definition = { title: "Mock inquiry", fields: [{ name: "email", label: "Email", type: "email" as const, required: true }] }
  const workflow = "wf_mock-form", version = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc"
  expect((await api.getTriggers(workflow))).toHaveLength(0)
  const created = await api.createHostedForm(workflow, version, definition)
  expect(HostedFormSetupSchema.parse((await api.getHostedForm(created.id)))).toMatchObject({ definition, workflowVersionId: version, status: "draft" })
  const original = await api.getHostedForm(created.id)
  const read = await api.getHostedForm(created.id)
  read.definition.title = "Caller mutation"
  expect((await api.getHostedForm(created.id)).definition.title).toBe("Mock inquiry")
  const changed = await api.updateHostedForm(created.id, { ...definition, title: "Updated mock" }, version, original.etag)
  expect(changed.publicUrl).not.toBe(original.publicUrl)
  expect(changed.version).toBe(2)
  await expect(api.updateHostedForm(created.id, definition, version, original.etag)).rejects.toThrow("Form changed")
  expect((await api.setHostedFormStatus(created.id, "enabled", changed.etag)).enabled).toBe(true)
  await expect(api.setHostedFormStatus(created.id, "disabled", changed.etag)).rejects.toThrow("Form changed")
  const enabled = await api.getHostedForm(created.id)
  await api.setHostedFormStatus(created.id, "archived", enabled.etag)
  expect(await api.getTriggers(workflow)).toHaveLength(0)
  await expect(api.setHostedFormStatus(created.id, "enabled", original.etag)).rejects.toThrow("Hosted form not found")
  await expect(api.createHostedForm(workflow, version, { ...definition, fields: [] })).rejects.toThrow()
})
