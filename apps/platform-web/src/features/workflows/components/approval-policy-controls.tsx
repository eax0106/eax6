import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { ApiHttpError } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import type { ApprovalPolicies, ApprovalPolicyStep } from "@/api/types"
import { Button } from "@/components/ui/button"

export function ApprovalPolicyControls({ workflowId, nodeKey }: { workflowId: string; nodeKey: string }) {
  const query = useQuery({ queryKey: queryKeys.workflows.approvalPolicies(workflowId), queryFn: () => api.getApprovalPolicies(workflowId) })
  if (query.isPending) return <p>Loading approval settings…</p>
  if (query.isError) return <div role="alert">Approval settings could not be loaded. <Button onClick={() => query.refetch()}>Try again</Button></div>
  const step = query.data.policies.find(p => p.nodeKey === nodeKey)
  if (!step) return <p>Save and compile this approval step before changing its mode.</p>
  return <ApprovalPolicyForm key={`${nodeKey}:${step.etag}`} workflowId={workflowId} step={step} canEdit={query.data.canEdit} reload={query.refetch} />
}

function ApprovalPolicyForm({ workflowId, step, canEdit, reload }: {
  workflowId: string; step: ApprovalPolicyStep; canEdit: boolean; reload: () => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const radioName = React.useId()
  const [mode, setMode] = React.useState(step.mode)
  const [skip, setSkip] = React.useState(step.skipOnTimeout)
  const [timeoutWindow, setTimeoutWindow] = React.useState(String(step.timeoutSeconds ?? 60))
  const [confirmed, setConfirmed] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const needsConfirmation = mode === "auto" && step.sideEffectConsequence !== null
  const seconds = Number(timeoutWindow)
  const validWindow = !skip || (Number.isInteger(seconds) && seconds >= 60 && seconds <= 2_592_000)
  const timeoutSeconds = skip ? seconds : step.timeoutSeconds
  const dirty = mode !== step.mode || skip !== step.skipOnTimeout || timeoutSeconds !== step.timeoutSeconds
  const save = useMutation({
    mutationFn: () => api.setApprovalPolicy(workflowId, step.nodeKey, {
      mode, skipOnTimeout: skip, timeoutSeconds,
      ...(needsConfirmation && confirmed ? { confirmConsequence: step.sideEffectConsequence! } : {}),
    }, step.etag),
    onSuccess: saved => {
      queryClient.setQueryData<ApprovalPolicies>(queryKeys.workflows.approvalPolicies(workflowId), data =>
        data ? { ...data, policies: data.policies.map(p => p.nodeKey === saved.nodeKey ? saved : p) } : data)
    },
    onError: async failure => {
      if (failure instanceof ApiHttpError && failure.status === 412) {
        setError("Approval settings changed. Reloading before you save again.")
        await reload()
      } else setError("Approval settings could not be saved. Try again.")
    },
  })
  return <section className="space-y-3" aria-label="Approval settings">
    <h4 className="font-medium">Approval settings</h4>
    <p className="text-sm text-text-muted">Applies to future runs. Existing decisions stay recorded.</p>
    {!canEdit && <p>Approval rights are required to change these settings.</p>}
    {step.promotionSuggested && <p>You have approved the last 10 in a row. Switch to Always go ahead?</p>}
    <fieldset disabled={!canEdit || save.isPending} className="space-y-3">
      <legend className="sr-only">Approval mode</legend>
      <label className="flex gap-2"><input type="radio" name={radioName} checked={mode === "ask"} onChange={() => { setMode("ask"); setConfirmed(false) }} />Ask me first</label>
      <label className="flex gap-2"><input type="radio" name={radioName} checked={mode === "auto"} onChange={() => { setMode("auto"); setConfirmed(false) }} />Always go ahead</label>
      {needsConfirmation && <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I understand: {step.sideEffectConsequence}</label>}
      <label className="flex gap-2"><input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} />Skip on timeout and flag the run</label>
      {skip && <label className="block">Timeout window (seconds)<input type="number" min={60} max={2_592_000} step={1} value={timeoutWindow} onChange={e => setTimeoutWindow(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>}
      <Button type="button" disabled={!dirty || !validWindow || (needsConfirmation && !confirmed)} onClick={() => { setError(undefined); save.mutate() }}>Save approval settings</Button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </section>
}
