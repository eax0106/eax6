import { z } from "zod"
import { CompiledDagSchema, NodeOverrideChoiceSchema, NodeOverrideRequestSchema, NodeOverrideComparisonSchema, applyNodeOverride, hasExternalSideEffect, withNodeOverrideSafeguards, type NodeOverrideRequest, type NodeOverrideComparison } from "@alterx/contracts"
import { apiGet, apiPost, isLiveApi, mutationKey } from "./http"
import { delay, mockWorkflows } from "./mock/data"

export async function getNodeOverrideOptions(workflowId: string): Promise<{ can_edit: boolean }> {
  if (isLiveApi) return z.object({ can_edit: z.boolean() }).strict().parse(await apiGet(`/api/v1/workflows/${encodeURIComponent(workflowId)}/node-overrides`))
  await delay(200)
  if (!mockWorkflows.some(workflow => workflow.id === workflowId)) throw new Error("Workflow was not found")
  return { can_edit: true }
}

export async function compareNodeOverride(workflowId: string, input: NodeOverrideRequest): Promise<NodeOverrideComparison> {
  const body = NodeOverrideRequestSchema.parse(input)
  if (isLiveApi) return NodeOverrideComparisonSchema.parse(await apiPost(`/api/v1/workflows/${encodeURIComponent(workflowId)}/node-overrides/compare`, body, { idempotencyKey: mutationKey("node-override-compare") }))
  await delay(200)
  const workflow = mockWorkflows.find(item => item.id === workflowId)
  if (!workflow) throw new Error("Workflow was not found")
  const dag = z.object(CompiledDagSchema.shape).strict().parse(body.dag)
  const node = dag.nodes.find(item => item.key === body.nodeKey)
  if (!node || (body.choice.kind === "model" ? node.type !== "LLMTask" : node.type !== "ToolCall")) throw new Error("Choice does not match the selected node type")
  const original = workflow.dag?.nodes.find(item => item.key === node.key && item.type === node.type)
  const parsedChoice = NodeOverrideChoiceSchema.safeParse(original?.metadata.original_choice ?? (original?.type === "LLMTask"
    ? { kind: "model", value: original.config.model_alias } : original?.type === "ToolCall" ? { kind: "tool", value: original.config.tool_name } : null)
  )
  const value = parsedChoice.success ? parsedChoice.data : null
  const warnings = [{ code: "facts_unavailable", message: "Preview has no provider scores, prices or output guarantees. Live comparison uses recorded provider facts." }]
  if (body.choice.kind === "tool" && hasExternalSideEffect(body.choice.value) && (value?.kind !== "tool" || !hasExternalSideEffect(String(value.value)))) warnings.push({ code: "outside_action", message: "Chosen tool adds an outside action; normal tool permissions and approval steps still apply." })
  const dataContract = node.metadata.data_contract?.inputs ? { inputs: node.metadata.data_contract.inputs } : {}
  const proposed = withNodeOverrideSafeguards({ ...dag, nodes: dag.nodes.map(item => item.key === node.key ? { ...item, config: applyNodeOverride(item.config, body.choice), metadata: { ...item.metadata, data_contract: dataContract } } : item) }, true)
  const validation = CompiledDagSchema.safeParse(proposed)
  return NodeOverrideComparisonSchema.parse({ nodeKey: node.key, choice: body.choice, original: { choice: value, selection: original?.metadata.selection_binding ?? null }, candidate: null, warnings,
    approval_required: true,
    cost: { currency: "INR", before_minor: null, after_minor: null }, validation: { valid: validation.success, errors: validation.success ? [] : validation.error.issues.map(issue => issue.message) }, data_contract: dataContract })
}
