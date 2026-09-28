import { apiGet, apiPost, mutationKey } from "./http"

// Discovery (task B3.3): live adapter over /api/v1/discovery/recommendations.
// The API derives suggestions from the workspace's own runs, documents,
// approvals and connector activity; accepting one creates a draft workflow.

export interface WorkspaceSuggestion {
  id: string
  problemStatement: string
  estimatedValue: number
  estimatedEffort: number
  requiredIntegrations: string[]
  riskLevel: "low" | "medium" | "high"
  confidence: number
}

type AnyRecord = Record<string, unknown>

function mapSuggestion(value: unknown): WorkspaceSuggestion & { status: string } {
  const item = value as AnyRecord
  return {
    id: String(item.id),
    problemStatement: String(item.problemStatement),
    estimatedValue: Number(item.estimatedValue ?? 0),
    estimatedEffort: Number(item.estimatedEffort ?? 0),
    requiredIntegrations: Array.isArray(item.requiredIntegrations) ? item.requiredIntegrations.map(String) : [],
    riskLevel: item.riskLevel === "high" || item.riskLevel === "medium" ? item.riskLevel : "low",
    confidence: Number(item.confidence ?? 0),
    status: String(item.status),
  }
}

/** Open suggestions only; accepted and dismissed ones are history. */
export async function listSuggestions(): Promise<WorkspaceSuggestion[]> {
  const body = await apiGet<unknown>("/api/v1/discovery/recommendations")
  return (Array.isArray(body) ? body : [])
    .map(mapSuggestion)
    .filter((item) => item.status === "suggested")
    .map(({ status: _status, ...suggestion }) => suggestion)
}

/** Creates the draft workflow and returns its id. */
export async function acceptSuggestion(id: string): Promise<string> {
  const body = (await apiPost<unknown>(
    `/api/v1/discovery/recommendations/${encodeURIComponent(id)}/actions/accept`,
    undefined,
    { idempotencyKey: mutationKey("discovery-accept") },
  )) as AnyRecord
  const workflowId = (body?.evidence as AnyRecord | undefined)?.created_workflow_id
  if (typeof workflowId !== "string" || workflowId.length === 0) throw new Error("The draft workflow was not returned")
  return workflowId
}

export async function dismissSuggestion(id: string): Promise<void> {
  await apiPost<void>(`/api/v1/discovery/recommendations/${encodeURIComponent(id)}/actions/dismiss`, undefined, {
    idempotencyKey: mutationKey("discovery-dismiss"),
  })
}
