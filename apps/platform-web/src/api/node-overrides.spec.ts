import { afterEach, expect, it, vi } from "vitest"
vi.mock("./http", async original => ({ ...(await original<typeof import("./http")>()), isLiveApi: false }))
vi.mock("./mock/data", async original => ({ ...(await original<typeof import("./mock/data")>()), delay: async () => {} }))
import { api } from "./client"
import { compileDag, dagToCanvas } from "./compile-dag"
import { compareNodeOverride } from "./node-overrides"
import { mockWorkflows } from "./mock/data"

const workflow = mockWorkflows[0]!
const original = structuredClone(workflow)
afterEach(() => { Object.assign(workflow, original); if (!original.dag) delete workflow.dag })

it("mock comparison reports unknown provider facts and persists canonical manual model/evidence across reads", async () => {
  workflow.dag = compileDag([{ id: "work", type: "LLMTask", position: { x: 0, y: 0 }, data: { label: "Work", model_alias: "STANDARD" } }], [])
  const dag = structuredClone(workflow.dag)
  dag.nodes[0]!.metadata.original_choice = { kind: "model", value: "CEILING" }
  const advice = await compareNodeOverride(workflow.id, { nodeKey: "work", choice: { kind: "model", value: "FAST" }, dag })
  expect(advice.original.choice).toEqual({ kind: "model", value: "STANDARD" })
  expect(advice.original.selection).toBeNull()
  expect(advice.candidate).toBeNull()
  expect(advice.cost).toEqual({ currency: "INR", before_minor: null, after_minor: null })
  expect(advice.validation.valid).toBe(true)
  expect(advice.warnings.map(warning => warning.code)).toEqual(["facts_unavailable"])
  dag.nodes[0]!.config = { model_alias: "FAST", manual_model_override: true }
  const canvas = dagToCanvas(dag)
  await api.saveWorkflowGraph(workflow.id, canvas)
  expect((await api.getWorkflow(workflow.id)).dag!.nodes[0]!.config).toEqual({ model_alias: "FAST", manual_model_override: true })
  expect(workflow.dag!.nodes[0]!.metadata.original_choice).toEqual({ kind: "model", value: "STANDARD" })
})

it("mock outside tool advice retains choice but rejects a missing normal boundary on save", async () => {
  const dag = compileDag([{ id: "work", type: "ToolCall", position: { x: 0, y: 0 }, data: { label: "Work", tool_name: "search.web" } }], [])
  workflow.dag = structuredClone(dag)
  dag.nodes[0]!.metadata.override_safeguards = { approval_required: false }
  const advice = await compareNodeOverride(workflow.id, { nodeKey: "work", choice: { kind: "tool", value: "email.send" }, dag })
  expect(advice.choice).toEqual({ kind: "tool", value: "email.send" })
  expect(advice.original.choice).toEqual({ kind: "tool", value: "search.web" })
  expect(advice.warnings.some(warning => warning.code === "outside_action")).toBe(true)
  expect(advice.validation.valid).toBe(false)
  dag.nodes[0]!.config = { tool_name: "email.send", manual_tool_override: true }
  await expect(api.saveWorkflowGraph(workflow.id, dagToCanvas(dag))).rejects.toThrow()
  expect(workflow.dag!.nodes[0]!.config.tool_name).toBe("search.web")
})
