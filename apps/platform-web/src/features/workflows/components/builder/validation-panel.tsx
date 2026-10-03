import { AlertCircle } from "lucide-react"
import { CompiledDagSchema } from "@alterx/contracts"
import { compileDag } from "@/api/compile-dag"
import { useBuilderStore } from "../../stores/useBuilderStore"

export function ValidationPanel() {
  const { nodes, edges, successCriteria } = useBuilderStore()
  if (!nodes.length) return null
  let issues: string[] = []
  try {
    const result = CompiledDagSchema.safeParse(compileDag(nodes, edges, successCriteria))
    if (!result.success) issues = result.error.issues.map(issue => issue.message)
  } catch (error) { issues = [error instanceof Error ? error.message : "Graph validation could not complete"] }

  if (issues.length === 0) {
    return null
  }

  return (
    <div className="absolute bottom-4 left-4 z-10 w-80 rounded-lg border border-border bg-surface p-4 shadow-lg">
      <h4 className="mb-3 text-sm font-semibold text-foreground">Workflow Checks</h4>
      <div className="space-y-2">
        {issues.map((issue, i) => (
          <div key={i} role="alert" className="flex gap-2 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <span className="text-red-500 font-medium">{issue}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
