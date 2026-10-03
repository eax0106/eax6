import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ModelAliasSchema, TOOL_NAMES, NodeOverrideChoiceSchema, applyNodeOverride, type NodeOverrideChoice, type NodeSelectionEvidence, type NodeOverrideComparison } from "@alterx/contracts"
import { api } from "@/api/client"
import { compileDag } from "@/api/compile-dag"
import { Button } from "@/components/ui/button"
import { useBuilderStore } from "../../stores/useBuilderStore"

export function NodeOverrideControls({ workflowId, nodeKey }: { workflowId: string; nodeKey: string }) {
  const state = useBuilderStore()
  const node = state.nodes.find(item => item.id === nodeKey)
  const kind = node?.type === "LLMTask" ? "model" : "tool"
  const field = kind === "model" ? "model_alias" : "tool_name"
  const [error, setError] = React.useState<string>()
  const [advice, setAdvice] = React.useState<NodeOverrideComparison>()
  const options = useQuery({ queryKey: ["workflows", workflowId, "node-overrides"], queryFn: () => api.getNodeOverrideOptions(workflowId) })
  const compare = useMutation({
    mutationFn: ({ choice, snapshot }: { choice: NodeOverrideChoice; snapshot: ReturnType<typeof useBuilderStore.getState> }) => api.compareNodeOverride(workflowId, {
      nodeKey, choice, dag: compileDag(snapshot.nodes, snapshot.edges, snapshot.successCriteria),
    }),
    onSuccess: (result, { snapshot }) => {
      const current = useBuilderStore.getState()
      if (current.workflowId !== workflowId || current.nodes !== snapshot.nodes || current.edges !== snapshot.edges || current.successCriteria !== snapshot.successCriteria) {
        setError("Graph changed during comparison. Compare the current choice again."); return
      }
      setAdvice(result)
      const metadata = current.nodes.find(item => item.id === nodeKey)?.data.engineMetadata as Record<string, unknown> | undefined
      current.updateNodeData(nodeKey, { engineMetadata: { ...metadata,
        selection_binding: result.original.selection ?? undefined, original_choice: result.original.choice ?? undefined,
        data_contract: result.data_contract ?? undefined,
        override_safeguards: { approval_required: result.approval_required },
      } })
    },
    onError: () => setError("Comparison could not be loaded. Your choice is kept; try again."),
  })
  if (!node) return null
  const config = { ...(node.data.config as Record<string, unknown> | undefined), ...node.data }
  const metadata = node.data.engineMetadata as Record<string, unknown> | undefined
  const selection = metadata?.selection_binding as NodeSelectionEvidence | undefined
  const original = NodeOverrideChoiceSchema.safeParse(metadata?.original_choice)
  const choices = kind === "model" ? ModelAliasSchema.options : TOOL_NAMES
  const choose = (value: string) => {
    const choice = NodeOverrideChoiceSchema.parse({ kind, value })
    setError(undefined); setAdvice(undefined)
    state.updateNodeData(nodeKey, applyNodeOverride({}, choice))
    compare.mutate({ choice, snapshot: useBuilderStore.getState() })
  }
  return <section aria-label="Node override" className="space-y-3">
    <h4 className="text-sm font-medium">{kind === "model" ? "Model choice" : "Tool choice"}</h4>
    <label className="block text-sm">{kind === "model" ? "Model alias" : "Canonical tool"}
      <select aria-label={kind === "model" ? "Model alias" : "Canonical tool"} value={String(config[field] ?? "")} disabled={!options.data?.can_edit}
        onChange={event => choose(event.target.value)} className="mt-1 w-full rounded border border-border bg-surface p-2">
        {!config[field] && <option value="" disabled>Choose…</option>}
        {choices.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    {options.isPending && <p>Loading editing rights…</p>}
    {options.isError && <p role="alert">Editing rights could not be loaded. <Button onClick={() => options.refetch()}>Try again</Button></p>}
    {options.data && !options.data.can_edit && <p>Editor rights are required to change this node.</p>}
    <div className="space-y-1 text-sm">
      <p>Original pick: {original.success ? original.data.value : selection?.model_alias ?? selection?.tool_name ?? "Not recorded"}</p>
      {selection ? <>
        <p>{selection.binding.rationale}</p>
        <p>Selection score: {selection.binding.score.toFixed(3)}</p>
        <p>{selection.binding.record_id} · version {selection.binding.version}</p>
        <ul>{Object.entries(selection.binding.factors).map(([name, value]) => <li key={name}>{name}: {value.toFixed(3)}</li>)}</ul>
        {selection.policy && <p>Weights: reliability {selection.policy.reliability_weight}, latency {selection.policy.latency_weight}, cost {selection.policy.cost_weight}</p>}
      </> : <p>Original reasoning and scores were not recorded.</p>}
    </div>
    <Button type="button" variant="outline" disabled={!options.data?.can_edit || compare.isPending || !config[field]} onClick={() => choose(String(config[field]))}>Compare choice</Button>
    {compare.isPending && <p role="status">Comparing choice…</p>}
    {error && <p role="alert">{error}</p>}
    {advice && <div aria-label="Override advice" className="space-y-2 text-sm">
      <p>Warnings are advice. Your manual choice stays selected.</p>
      {advice.candidate && <>
        <p>Candidate: {advice.candidate.record_id} · version {advice.candidate.version}</p>
        <p>Candidate score: {advice.candidate.score === null ? "Unavailable" : advice.candidate.score.toFixed(3)}</p>
        <ul>{Object.entries(advice.candidate.factors ?? {}).map(([name, value]) => <li key={name}>{name}: {value.toFixed(3)}</li>)}</ul>
      </>}
      {advice.cost.before_minor !== null && advice.cost.after_minor !== null && <p>At most per run: ₹{(advice.cost.before_minor / 100).toFixed(2)} → ₹{(advice.cost.after_minor / 100).toFixed(2)}</p>}
      <ul>{advice.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
      <p>{advice.validation.valid ? "Graph validation passed." : "Fix graph validation errors before saving or compiling."}</p>
      {!advice.validation.valid && <ul role="alert">{advice.validation.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
    </div>}
  </section>
}
