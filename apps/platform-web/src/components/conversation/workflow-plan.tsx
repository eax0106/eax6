import { useState } from "react"
import type { WorkflowPlan } from "@alterx/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function WorkflowPlanCard({ plan, onBuild, pending, disabled = false }: {
  plan: WorkflowPlan; onBuild: (criteria: string[]) => void; pending: boolean; disabled?: boolean
}) {
  const [criteria, setCriteria] = useState(plan.successCriteria)
  return <section className="space-y-4 rounded-lg border border-border p-4" aria-label="Workflow plan">
    <h3 className="font-medium">Review workflow plan</h3>
    <ol className="list-decimal space-y-2 pl-5">{plan.steps.map(step => <li key={step.key}>
      <p>{step.description}</p>
      {step.successCriteria.length > 0 && <ul className="list-disc pl-5 text-sm text-muted-foreground">
        {step.successCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}
      </ul>}
    </li>)}</ol>
    <fieldset disabled={pending || disabled} className="space-y-2">
      <legend className="mb-2 font-medium">Success criteria</legend>
      {criteria.map((criterion, index) => <div key={index} className="flex gap-2">
        <Input aria-label={`Success criterion ${index + 1}`} maxLength={1000} value={criterion}
          onChange={event => setCriteria(criteria.map((value, i) => i === index ? event.target.value : value))} />
        <Button variant="outline" aria-label={`Remove criterion ${index + 1}`} onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}>Remove</Button>
      </div>)}
      <Button variant="outline" disabled={criteria.length >= 100} onClick={() => setCriteria([...criteria, ""])}>Add criterion</Button>
      <p className="text-sm text-muted-foreground">Build confirms these criteria and assigns them to steps.</p>
      <Button disabled={criteria.some(criterion => !criterion.trim())} onClick={() => onBuild(criteria.map(criterion => criterion.trim()))}>Build</Button>
    </fieldset>
  </section>
}
