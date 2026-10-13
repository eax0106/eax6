import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import type { WorkflowVersion } from "@/api/types"

// The engine runs compiled, canary and promoted versions; the rest are history.
const RUNNABLE = new Set<WorkflowVersion["status"]>(["compiled", "canary", "promoted"])

export function runnableVersions(versions: WorkflowVersion[]): WorkflowVersion[] {
  return versions
    .filter(version => RUNNABLE.has(version.status))
    .sort((a, b) => Number(b.status === "promoted") - Number(a.status === "promoted") || b.version - a.version)
}

export function parseRunInput(text: string): Record<string, unknown> | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return "Input must be valid JSON."
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Input must be a JSON object, like {\"recipient\": \"you@example.com\"}."
  }
  return value as Record<string, unknown>
}

interface RunWithInputDialogProps {
  workflowId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RunWithInputDialog({ workflowId, open, onOpenChange }: RunWithInputDialogProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [text, setText] = React.useState("{\n  \n}")
  const [versionId, setVersionId] = React.useState("")

  const versions = useQuery({
    queryKey: queryKeys.workflows.versions(workflowId),
    queryFn: () => api.getWorkflowVersions(workflowId),
    enabled: open,
  })
  const runnable = runnableVersions(versions.data ?? [])
  const selected = versionId || runnable[0]?.id || ""
  const parsed = parseRunInput(text)

  const mutation = useMutation({
    mutationFn: () => api.startRun(workflowId, selected, parsed as Record<string, unknown>),
    onSuccess: run => {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflowId) })
      onOpenChange(false)
      navigate(`/app/runs/${run.id}`)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (typeof parsed === "string" || !selected) return
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Run with input</DialogTitle>
          <DialogDescription>
            Starts a real run. The input goes to the workflow's first step, the way a form submission would.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="run-input-version">Version</Label>
            {versions.isLoading && <p className="text-sm text-muted-foreground">Loading versions…</p>}
            {!versions.isLoading && runnable.length === 0 && (
              <p className="text-sm text-destructive" role="alert">This workflow has no compiled version to run.</p>
            )}
            {runnable.length > 0 && (
              <Select id="run-input-version" value={selected} onChange={e => setVersionId(e.target.value)}>
                {runnable.map(version => (
                  <option key={version.id} value={version.id}>
                    Version {version.version} ({version.status})
                  </option>
                ))}
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="run-input-json">Input (JSON)</Label>
            <Textarea
              id="run-input-json"
              className="min-h-[200px] font-mono"
              value={text}
              onChange={e => setText(e.target.value)}
              error={typeof parsed === "string"}
              spellCheck={false}
            />
            {typeof parsed === "string" && <p className="text-xs text-destructive">{parsed}</p>}
          </div>

          {mutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {mutation.error instanceof Error ? mutation.error.message : "The run could not be started."}
            </p>
          )}

          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || typeof parsed === "string" || !selected}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Start run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
