import { afterEach, expect, it, vi } from "vitest"
import { CompiledDagSchema } from "@alterx/contracts"

vi.mock("./http", async importOriginal => ({ ...await importOriginal<object>(), isLiveApi: false }))
vi.mock("./mock/data", async importOriginal => ({ ...await importOriginal<object>(), delay: async () => {} }))

import { api } from "./client"

afterEach(() => vi.restoreAllMocks())

it("keeps the same mock draft and builds only the complete confirmed list, including removal of all criteria", async () => {
  let clock = 1900000000000
  vi.spyOn(Date, "now").mockImplementation(() => clock++)
  const preview = await api.compileWorkflow({ goal: "Review invoices", answers: {} })
  expect(preview.plan?.successCriteria).toEqual(["Review invoices"])
  expect(preview.workflow.dag).toBeUndefined()
  const criteria = ["Approve invoices", "Archive invoices"]
  const built = await api.compileWorkflow({ goal: "Review invoices", answers: {}, workflowId: preview.workflow.id, confirm: true, successCriteria: criteria })
  expect(built.workflow.id).toBe(preview.workflow.id)
  expect((await api.getWorkflow(built.workflow.id)).dag).toMatchObject({ success_criteria: criteria, nodes: [{ success_criteria: criteria }] })
  await api.compileWorkflow({ goal: "Review invoices", answers: {}, workflowId: built.workflow.id, confirm: true, successCriteria: [] })
  const empty = CompiledDagSchema.parse((await api.getWorkflow(built.workflow.id)).dag)
  expect(empty.success_criteria ?? []).toEqual([])
  expect(empty.nodes[0]!.success_criteria ?? []).toEqual([])
  await expect(api.compileWorkflow({ goal: "Review invoices", answers: {}, successCriteria: criteria })).rejects.toThrow("Build confirmation is required")
})

it("binds mock chat Build to the latest unconsumed plan and its stored objective", async () => {
  let clock = 1910000000000
  vi.spyOn(Date, "now").mockImplementation(() => clock++)
  const chat = await api.createConversation({ type: "workflow_builder", title: "Invoice review" })
  const first = (await api.sendMessage(chat.id, { content: "Review invoices" })).assistantMessage!
  expect(first.kind).toBe("artifact")
  expect((await api.getWorkflow(chat.linkedWorkflowId!)).dag).toBeUndefined()
  const latest = (await api.sendMessage(chat.id, { content: "Archive approved invoices" })).assistantMessage!
  await expect(api.sendMessage(chat.id, { content: "Build", build: { planMessageId: first.id, successCriteria: [] } })).rejects.toThrow("Review the latest plan")
  const criteria = ["Retain every approved invoice"]
  const reply = await api.sendMessage(chat.id, { content: "Build", build: { planMessageId: latest.id, successCriteria: criteria } })
  expect(reply.assistantMessage).toMatchObject({ kind: "workflow", content: { workflowId: chat.linkedWorkflowId } })
  const dag = (await api.getWorkflow(chat.linkedWorkflowId!)).dag!
  expect(dag.success_criteria).toEqual(criteria)
  expect(dag.nodes[0]!.config.prompt).toBe("Archive approved invoices")
  expect(dag.nodes[0]!.success_criteria).toEqual(criteria)
  await expect(api.sendMessage(chat.id, { content: "Build", build: { planMessageId: latest.id, successCriteria: criteria } })).rejects.toThrow("Review the latest plan")
})
