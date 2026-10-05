import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { parseCaseInput, parseCriteria } from "../run-format"

interface DraftCase { input: string; criteria: string }

const MAX_CASES = 100
const EMPTY_CASE: DraftCase = { input: "{\n  \n}", criteria: "" }

export function CreateBenchmarkPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [cases, setCases] = useState<DraftCase[]>([{ ...EMPTY_CASE }])
  const [errors, setErrors] = useState<string[]>([])

  const create = useMutation({
    mutationFn: api.benchmarks.createDataset,
    onSuccess: dataset => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.benchmarks.datasets })
      toast.success("Dataset created")
      navigate(`/app/benchmarks/${dataset.id}`)
    },
    onError: (error: Error) => toast.error(error.message || "The dataset could not be created"),
  })

  const update = (index: number, change: Partial<DraftCase>) =>
    setCases(current => current.map((item, position) => position === index ? { ...item, ...change } : item))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const problems: string[] = []
    if (!name.trim()) problems.push("Name the dataset.")
    const parsed = cases.map((item, index) => {
      const input = parseCaseInput(item.input)
      const successCriteria = parseCriteria(item.criteria)
      if (!input) problems.push(`Case ${index + 1}: the input must be a JSON object.`)
      if (successCriteria.length === 0) problems.push(`Case ${index + 1}: add at least one success criterion.`)
      if (successCriteria.length > 20) problems.push(`Case ${index + 1}: use at most 20 success criteria.`)
      return { input: input ?? {}, successCriteria }
    })
    setErrors(problems)
    if (problems.length === 0) create.mutate({ name: name.trim(), description: description.trim(), cases: parsed })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="New benchmark dataset"
        description="Each case is the input a workflow receives and the success criteria its result must meet." />
      <form onSubmit={submit} className="space-y-6" noValidate>
        <div className="rounded-xl border border-border bg-surface p-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="benchmark-name">Name</Label>
            <Input id="benchmark-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="benchmark-description">Description</Label>
            <Textarea id="benchmark-description" value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} />
          </div>
        </div>

        {cases.map((item, index) => (
          <fieldset key={index} className="rounded-xl border border-border bg-surface p-6 space-y-4">
            <div className="flex items-center justify-between">
              <legend className="font-medium text-text-primary">Case {index + 1}</legend>
              {cases.length > 1 && (
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove case ${index + 1}`}
                  onClick={() => setCases(current => current.filter((_, position) => position !== index))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`case-${index}-input`}>Input (JSON object)</Label>
              <Textarea id={`case-${index}-input`} className="font-mono text-xs" rows={5} value={item.input}
                onChange={event => update(index, { input: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`case-${index}-criteria`}>Success criteria (one per line)</Label>
              <Textarea id={`case-${index}-criteria`} rows={3} value={item.criteria}
                onChange={event => update(index, { criteria: event.target.value })} />
            </div>
          </fieldset>
        ))}

        {errors.length > 0 && (
          <ul role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive space-y-1">
            {errors.map(problem => <li key={problem}>{problem}</li>)}
          </ul>
        )}

        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" disabled={cases.length >= MAX_CASES}
            onClick={() => setCases(current => [...current, { ...EMPTY_CASE }])}>
            <Plus className="mr-2 h-4 w-4" />Add case
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate("/app/benchmarks")}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create dataset"}</Button>
          </div>
        </div>
      </form>
    </div>
  )
}
