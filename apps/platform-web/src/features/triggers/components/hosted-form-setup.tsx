import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { HostedFormDefinitionSchema, type HostedFormDefinition, type HostedFormField } from "@alterx/contracts"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"

const initial: HostedFormDefinition = { title: "Incoming submission", description: "", fields: [{ name: "email", label: "Email", type: "email", required: true }] }

export function HostedFormSetupPanel({ workflowId, triggerId, onClose }: { workflowId: string; triggerId?: string; onClose: () => void }) {
  const client = useQueryClient()
  const [source, setSource] = useState(triggerId ? "hosted" : "own")
  const [definition, setDefinition] = useState<HostedFormDefinition>(initial)
  const [versionId, setVersionId] = useState("")
  const [validation, setValidation] = useState("")
  const [createdId, setCreatedId] = useState<string>()
  const id = triggerId ?? createdId
  const current = useQuery({ queryKey: ["hosted-form", id], enabled: Boolean(id), refetchOnWindowFocus: false, refetchOnReconnect: false, queryFn: async () => {
    const result = await api.getHostedForm(id!)
    setDefinition(result.definition)
    setVersionId(result.workflowVersionId ?? "")
    return result
  } })
  const versions = useQuery({ queryKey: ["hosted-form-workflow-versions", workflowId], enabled: source === "hosted", queryFn: () => api.getWorkflowVersions(workflowId) })
  const refresh = () => {
    client.invalidateQueries({ queryKey: queryKeys.triggers.list(workflowId) })
    client.invalidateQueries({ queryKey: ["hosted-form", id] })
  }
  const save = useMutation({ mutationFn: async () => {
    const form = HostedFormDefinitionSchema.parse(definition)
    if (!versionId) throw new Error("Select a workflow version before saving.")
    if (id) {
      if (!current.data) throw new Error("Reload the form before saving.")
      await api.updateHostedForm(id, form, versionId, current.data.etag)
    } else {
      const result = await api.createHostedForm(workflowId, versionId, form)
      setCreatedId(result.id)
    }
  }, onSuccess: refresh })
  const status = useMutation({ mutationFn: async (enable: boolean) => {
    if (!id || !current.data) throw new Error("Reload the form before changing its status.")
    await api.setHostedFormStatus(id, enable ? "enabled" : "disabled", current.data.etag)
  }, onSuccess: refresh })
  const field = (index: number, value: HostedFormField) => setDefinition(d => ({ ...d, fields: d.fields.map((f, i) => i === index ? value : f) }))
  const error = validation || [current.error, versions.error, save.error, status.error].find(Boolean)?.message
  const busy = save.isPending || status.isPending || current.isFetching
  const control = "rounded border border-border bg-background px-3 py-2 text-sm w-full"
  return <section aria-label="Trigger setup" className="rounded-xl border border-border p-4 space-y-4">
    <div className="flex justify-between"><h3 className="font-medium">{id ? "Hosted form settings" : "Choose submission source"}</h3><Button variant="ghost" onClick={onClose}>Close setup</Button></div>
    {!id && <fieldset className="space-y-2"><legend className="sr-only">Submission source</legend>
      <label className="block"><input type="radio" name="submission-source" checked={source === "own"} onChange={() => setSource("own")} /> Connect my own source</label>
      <label className="block"><input type="radio" name="submission-source" checked={source === "hosted"} onChange={() => setSource("hosted")} /> Use an Alter hosted form</label>
    </fieldset>}
    {source === "own" ? <p className="text-sm">Keep your existing form, CRM or website. <a className="underline" href="/app/connections">Connect your source</a> or configure its webhook.</p> : <>
      <p className="text-sm text-muted-foreground">Public submissions use a bot check and input safeguards. File uploads are unavailable.</p>
      {current.data && <div className="space-y-1 text-sm"><p>Form is {current.data.status}. Saving fields replaces this link.</p><a className="underline break-all" href={current.data.publicUrl} target="_blank" rel="noreferrer">{current.data.publicUrl}</a></div>}
      <label className="block text-sm">Workflow version<select className={control} value={versionId} onChange={e => setVersionId(e.target.value)} disabled={busy || versions.isLoading}>
        <option value="">Select workflow version</option>{versions.data?.filter(v => v.status !== "retired").map(v => <option key={v.id} value={v.id}>Version {v.version} ({v.status})</option>)}
      </select></label>
      {!versions.isLoading && !versions.error && !versions.data?.length && <p className="text-sm">Compile a workflow version before creating its hosted form.</p>}
      <label className="block text-sm">Form title<input className={control} maxLength={160} value={definition.title} onChange={e => setDefinition({ ...definition, title: e.target.value })} disabled={busy} /></label>
      <label className="block text-sm">Description<textarea className={control} maxLength={2000} value={definition.description ?? ""} onChange={e => setDefinition({ ...definition, description: e.target.value })} disabled={busy} /></label>
      {definition.fields.map((f, index) => <fieldset key={index} className="border border-border rounded p-3 space-y-2" disabled={busy}>
        <legend>Field {index + 1}</legend>
        <label className="block text-sm">Field key<input className={control} value={f.name} maxLength={64} onChange={e => field(index, { ...f, name: e.target.value })} /></label>
        <label className="block text-sm">Field label<input className={control} value={f.label} maxLength={120} onChange={e => field(index, { ...f, label: e.target.value })} /></label>
        <label className="block text-sm">Field type<select className={control} value={f.type} onChange={e => field(index, { name: f.name, label: f.label, required: f.required, type: e.target.value, ...(e.target.value === "select" ? { options: ["Option 1"] } : {}), ...(["text", "textarea"].includes(e.target.value) ? { maxLength: 2000 } : {}) } as HostedFormField)}>
          <option value="text">Short text</option><option value="textarea">Long text</option><option value="email">Email</option><option value="number">Number</option><option value="select">Choice</option>
        </select></label>
        {(f.type === "text" || f.type === "textarea") && <label className="block text-sm">Maximum characters<input className={control} type="number" min={1} max={10000} value={f.maxLength} onChange={e => field(index, { ...f, maxLength: Number(e.target.value) })} /></label>}
        {f.type === "number" && (["min", "max"] as const).map(bound => <label key={bound} className="block text-sm">{bound === "min" ? "Minimum" : "Maximum"}<input className={control} type="number" value={f[bound] ?? ""} onChange={e => { const next = { ...f }; if (e.target.value === "") delete next[bound]; else next[bound] = Number(e.target.value); field(index, next) }} /></label>)}
        {f.type === "select" && <label className="block text-sm">Choices (one per line)<textarea className={control} value={f.options.join("\n")} onChange={e => field(index, { ...f, options: e.target.value.split("\n") })} /></label>}
        <label className="block text-sm"><input type="checkbox" checked={f.required} onChange={e => field(index, { ...f, required: e.target.checked })} /> Required</label>
        <Button variant="ghost" disabled={definition.fields.length === 1} onClick={() => setDefinition({ ...definition, fields: definition.fields.filter((_, i) => i !== index) })}>Remove field {index + 1}</Button>
      </fieldset>)}
      <Button variant="outline" disabled={busy || definition.fields.length >= 20} onClick={() => setDefinition({ ...definition, fields: [...definition.fields, { name: Array.from({ length: 20 }, (_, i) => `field_${i + 1}`).find(name => !definition.fields.some(f => f.name === name))!, label: "New field", type: "text", maxLength: 2000, required: false }] })}>Add field</Button>
      <div className="flex gap-2"><Button disabled={busy || !versionId || Boolean(current.error) || Boolean(id && !current.data)} onClick={() => {
        const result = HostedFormDefinitionSchema.safeParse(definition)
        setValidation(result.success ? "" : result.error.issues.map(i => i.message).join("; "))
        if (result.success) save.mutate()
      }}>{save.isPending ? "Saving…" : id ? "Save form" : "Create hosted form"}</Button>
        {current.data && current.data.status !== "archived" && <Button variant="outline" disabled={busy} onClick={() => status.mutate(current.data!.status !== "enabled")}>{current.data.status === "enabled" ? "Disable form" : "Enable form"}</Button>}
        {id && <Button variant="outline" disabled={busy} onClick={() => { setValidation(""); save.reset(); status.reset(); void current.refetch() }}>Reload form</Button>}
      </div>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
