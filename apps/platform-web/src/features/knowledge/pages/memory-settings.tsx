import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { ApiHttpError } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

const switches = [
  ["conversationMemoryEnabled", "Chat memory", "Recall earlier messages when building this workflow."],
  ["workflowMemoryEnabled", "Workflow memory", "Reuse lessons from this workflow’s past runs."],
  ["workspaceMemoryEnabled", "Workspace memory", "Share lessons across this workspace through ADS."],
] as const

export function MemorySettingsPage() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: queryKeys.knowledge.memory, queryFn: () => api.getMemoryConfiguration() })
  const [draft, setDraft] = useState(query.data)
  const [days, setDays] = useState("")
  useEffect(() => { if (query.data) { setDraft(query.data); setDays(String(query.data.retentionDays)) } }, [query.data])
  const save = useMutation({
    mutationFn: () => api.updateMemoryConfiguration({ ...draft, retentionDays: Number(days) }),
    onSuccess: value => client.setQueryData(queryKeys.knowledge.memory, value),
  })
  if (query.isLoading) return <p role="status">Loading memory settings…</p>
  if (query.isError) return <div role="alert">Could not load memory settings. <Button onClick={() => query.refetch()}>Retry</Button></div>
  if (!draft) return null
  const valid = /^\d+$/.test(days) && Number(days) >= 7 && Number(days) <= 365
  const stale = save.error instanceof ApiHttpError && save.error.status === 412
  return <div className="mx-auto w-full max-w-4xl space-y-6 overflow-auto p-8">
    <PageHeader title="Memory settings" description="Control memory for the current workspace. Memories are always PII redacted." />
    <fieldset disabled={save.isPending} className="space-y-6 rounded-xl border p-6">
      <legend>Memory scopes</legend>
      {switches.map(([key, title, description]) => <div key={key} className="flex items-center justify-between gap-6">
        <div><Label htmlFor={key}>{title}</Label><p id={`${key}-description`} className="text-sm text-muted-foreground">{description}</p></div>
        <Switch id={key} aria-describedby={`${key}-description`} checked={draft[key]}
          onCheckedChange={checked => setDraft({ ...draft, [key]: checked })} />
      </div>)}
      <div><Label htmlFor="memory-retention">Retention days</Label>
        <Input id="memory-retention" type="number" min={7} max={365} step={1} value={days}
          aria-invalid={!valid} aria-describedby="memory-retention-help" onChange={event => setDays(event.target.value)} />
        <p id="memory-retention-help">7–365 days; default 90. Older memories are deleted by the retention sweep.</p>
      </div>
      <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save settings"}</Button>
    </fieldset>
    {save.isError && <div role="alert">{stale ? "Settings changed while you were editing. Reload before saving." : "Could not save memory settings. Try again."}
      {stale && <Button onClick={() => { save.reset(); query.refetch() }}>Reload settings</Button>}</div>}
    {save.isSuccess && <p role="status">Memory settings saved.</p>}
  </div>
}
