import { CreateWorkflowChatRequestSchema, SendWorkflowChatMessageSchema, WorkflowChatResourceSchema, WorkflowChatMessageSchema, WorkflowChatExchangeSchema } from "@alterx/contracts"
import { apiDelete, apiGet, apiGetWithEtag, apiPatch, apiPost, apiPut, mutationKey } from "./http"
import { compileDag } from "./compile-dag"
import { WorkflowHealthResourceSchema, WorkflowHealthPageSchema } from "@alterx/contracts"
import type {
  AvailableRepository,
  RepositoryBinding,
  RepositoryBranch,
  RepositoryPullRequest,
  HumanActionFilters,
  Artifact,
  DashboardOverview,
  DashboardSummary,
  IncomingEvent,
  EventReplayPreview,
  Member,
  NodeTypeDefinition,
  Profile,
  Project,
  ProjectClarification,
  ProjectFile,
  Run,
  Session,
  TestResult,
  Trigger,
  WebhookEndpoint,
  Workflow,
  RunCostEstimate,
  WorkflowSafeguards,
  WorkflowVersion,
  WorkflowHealth,
  WorkflowHealthCollection,
  Workspace,
  PendingDeletionWorkspace,
  WorkspaceRole,
  TenantDataResidency,
  TenantDataResidencySettings,
  HumanAction,
  HumanActionType,
  HumanActionStatus,
  HumanActionPriority,
  HumanAnnotation,
  Credential,
  RecoveryEvent,
  NodeVerification,
  VerificationCheck,
  VerificationStatus,
  KnowledgeSource,
  KnowledgeSourceType,
  KnowledgeDocument,
  RetrievalResult,
  IntegrationDefinition,
  IntegrationCategory,
  Connection,
  WhatsAppChannel,
  WhatsAppTemplate,
  WhatsAppTestMessage,
} from "./types"

type AnyRecord = Record<string, any>

export async function getWorkflowHealths(cursor?: string): Promise<WorkflowHealthCollection> {
  const query = new URLSearchParams({ limit: "50" })
  if (cursor) query.set("cursor", cursor)
  return WorkflowHealthPageSchema.parse(await apiGet<unknown>(`/api/v1/workflows/health?${query}`)) as WorkflowHealthCollection
}

export async function getWorkflowHealth(workflowId: string): Promise<WorkflowHealth> {
  return WorkflowHealthResourceSchema.parse(await apiGet<unknown>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/health`)) as WorkflowHealth
}

export async function getDashboardSummary(fallback: DashboardSummary): Promise<DashboardSummary> {
  const [workflows, runs] = await Promise.all([
    getWorkflows().catch(() => []),
    getRuns().catch(() => []),
  ])
  const completed = runs.filter((run) => run.status === "completed").length
  return {
    ...fallback,
    activeWorkflows: workflows.filter((workflow) => workflow.status === "active").length,
    runsToday: runs.length,
    successRate: runs.length ? Math.round((completed / runs.length) * 100) : fallback.successRate,
    recentWorkflows: workflows.slice(0, 5),
    recentRuns: runs.slice(0, 5),
  }
}

export async function getDashboardOverview(fallback: DashboardOverview): Promise<DashboardOverview> {
  const [workflows, runs] = await Promise.all([
    getWorkflows().catch(() => []),
    getRuns().catch(() => []),
  ])
  return {
    ...fallback,
    metrics: {
      activeWorkflows: workflows.filter((workflow) => workflow.status === "active").length,
      runsToday: runs.length,
      successRate: runs.length
        ? Math.round((runs.filter((run) => run.status === "completed").length / runs.length) * 100)
        : fallback.metrics.successRate,
      needsAttention: fallback.metrics.needsAttention,
    },
    liveRuns: runs.filter((run) => run.status === "running" || run.status === "waiting").slice(0, 5),
    projectBuilds: runs.filter((run) => run.mode === "project").slice(0, 5),
  }
}

export async function getWorkspaces(): Promise<Workspace[]> {
  const body = await apiGet<unknown>("/api/v1/workspaces")
  return asArray(body, "workspaces").map(mapWorkspace)
}

interface TenantViewResponse {
  id?: unknown
  name?: unknown
  role?: unknown
}

interface TenantDataResidencyResponse {
  data_residency?: {
    allowed?: unknown
    legal_basis?: unknown
  } | null
}

export async function getTenantDataResidencySettings(): Promise<TenantDataResidencySettings> {
  const tenants = asArray(await apiGet<unknown>("/api/v1/tenants"), "tenants")
  const tenant = tenants[0] as TenantViewResponse | undefined
  if (!tenant || typeof tenant.id !== "string") {
    throw new Error("Current tenant not found")
  }

  const tenantId = tenant.id
  const { data, etag } = await apiGetWithEtag<TenantDataResidencyResponse>(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/data-residency`,
  )

  return {
    tenantId,
    tenantName: typeof tenant.name === "string" ? tenant.name : "Tenant",
    role: mapTenantRole(tenant.role),
    dataResidency: mapTenantDataResidency(data.data_residency),
    ...(etag === undefined ? {} : { etag }),
  }
}

export async function updateTenantDataResidencySettings(
  tenantId: string,
  dataResidency: TenantDataResidency | null,
  etag: string | undefined,
): Promise<TenantDataResidencySettings> {
  if (!etag) throw new Error("Tenant data residency ETag missing")
  await apiPut(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/data-residency`,
    {
      data_residency: dataResidency === null
        ? null
        : {
            allowed: dataResidency.allowed,
            ...(dataResidency.legalBasis
              ? { legal_basis: dataResidency.legalBasis }
              : {}),
          },
    },
    { ifMatch: etag },
  )
  return getTenantDataResidencySettings()
}

export async function createWorkspace(data: { name: string; slug: string }): Promise<Workspace> {
  const body = await apiPost<unknown>("/api/v1/workspaces", { name: data.name }, {
    idempotencyKey: mutationKey("workspace-create"),
  })
  return mapWorkspace(body)
}

export async function updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace> {
  const current = await apiGet<unknown>(`/api/v1/workspaces/${encodeURIComponent(id)}`)
  const body = await apiPatch<unknown>(
    `/api/v1/workspaces/${encodeURIComponent(id)}`,
    { name: data.name },
    { ifMatch: etagFromWorkspace(current) },
  )
  return mapWorkspace(body)
}

// D2: deleting takes the workspace name typed exactly; the workspace becomes
// pending deletion and can be restored until its window ends.
export async function deleteWorkspace(id: string, confirmName: string): Promise<{ deletionDueAt: string }> {
  const body = await apiDelete<AnyRecord>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
    body: { confirm_name: confirmName },
    idempotencyKey: mutationKey("workspace-delete"),
  })
  return { deletionDueAt: asDate(body?.deletionDueAt ?? body?.deletion_due_at) }
}

export async function getPendingDeletionWorkspaces(): Promise<PendingDeletionWorkspace[]> {
  const body = await apiGet<unknown>("/api/v1/workspaces/pending-deletion")
  return asArray(body, "workspaces").map((value) => {
    const item = value as AnyRecord
    return {
      id: asString(item.id),
      name: String(item.name ?? "Workspace"),
      deletionDueAt: asDate(item.deletionDueAt ?? item.deletion_due_at),
    }
  })
}

export async function restoreWorkspace(id: string): Promise<void> {
  await apiPost<unknown>(`/api/v1/workspaces/${encodeURIComponent(id)}/actions/restore`, {}, {
    idempotencyKey: mutationKey("workspace-restore"),
  })
}

export async function getMembers(): Promise<Member[]> {
  const body = await apiGet<unknown>("/api/v1/members")
  return asArray(body, "members").map(mapMember)
}

export async function inviteMember(email: string, role: WorkspaceRole): Promise<Member> {
  const body = await apiPost<unknown>("/api/v1/members", { email, role }, {
    idempotencyKey: mutationKey("member-invite"),
  })
  return mapMember(body)
}

export async function removeMember(memberId: string): Promise<void> {
  await apiDelete(`/api/v1/members/${encodeURIComponent(memberId)}`)
}

export async function getProfile(fallback: Profile): Promise<Profile> {
  // GET /api/v1/auth/me is the real profile read (identity.controller.ts's
  // `me` handler); it returns {userId, tenantId, email, name}. The backend
  // stores no job title or photo, so none is shown rather than the demo's.
  const body = await apiGet<{ userId?: string; email?: string; name?: string }>("/api/v1/auth/me")
  return {
    ...fallback,
    id: body.userId ?? fallback.id,
    email: body.email ?? fallback.email,
    name: body.name ?? fallback.name,
    jobTitle: undefined,
    avatarUrl: undefined,
  }
}

/** Saves the display name, the one profile field the backend stores. */
export async function updateProfile(data: Partial<Profile>, fallback: Profile): Promise<Profile> {
  const body = await apiPatch<{ userId?: string; email?: string; name?: string }>("/api/v1/auth/me", { name: data.name })
  return {
    ...fallback,
    id: body.userId ?? fallback.id,
    email: body.email ?? fallback.email,
    name: body.name ?? fallback.name,
    jobTitle: undefined,
    avatarUrl: undefined,
  }
}

/** Signs the user out on every other device; the current session stays. */
export async function revokeOtherSessions(): Promise<void> {
  await apiDelete("/api/v1/auth/sessions")
}

export async function getSessions(): Promise<Session[]> {
  const body = await apiGet<unknown>("/api/v1/auth/sessions")
  return asArray(body, "sessions").map(mapSession)
}

export async function revokeSession(sessionId: string): Promise<void> {
  await apiDelete(`/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`)
}

// This is a personal preference (language-settings.tsx's own copy: "the
// language you prefer for the AlterX interface"), not a workspace setting,
// so this hits the per-user endpoint (i18n.controller.ts's
// updateUserLanguage), not i18n/workspaces/:id/language. The UI passes
// BCP-47-ish codes ("en-US"/"hi-IN"); the backend only accepts the bare
// subtag ("en"/"hi" -- i18n/types.ts's supportedLocales), hence the split.
/** The user's saved language, in the settings page's codes (en-US, hi-IN). */
export async function getLanguage(): Promise<string> {
  const body = await apiGet<{ language?: unknown }>("/api/v1/i18n/users/me/language")
  return body.language === "hi" ? "hi-IN" : "en-US"
}

export async function updateLanguage(lang: string): Promise<void> {
  const language = lang.split("-")[0]
  await apiPatch("/api/v1/i18n/users/me/language", { language })
}

export async function getWorkflows(): Promise<Workflow[]> {
  const body = await apiGet<unknown>("/api/v1/workflows")
  return asArray(body, "workflows").map(mapWorkflow)
}

/** The engine's name search over every workflow in the workspace (task B3.4). */
export async function searchWorkflows(query: string, limit: number): Promise<Workflow[]> {
  const body = await apiGet<unknown>(`/api/v1/workflows?q=${encodeURIComponent(query)}&limit=${limit}`)
  return asArray(body, "workflows").map(mapWorkflow)
}

export async function getWorkflow(id: string): Promise<Workflow> {
  return mapWorkflow(await apiGet<unknown>(`/api/v1/workflows/${encodeURIComponent(id)}`))
}

interface SafeguardsResponse {
  workspace?: { contains_pii?: unknown; approve_external_actions?: unknown }
  additions?: SafeguardSet
  effective?: SafeguardSet
}
interface SafeguardSet {
  customer_visible?: unknown
  contains_pii?: unknown
  approve_external_actions?: unknown
}

function minorOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

// D4: "usually X, at most Y" before a run, billed price only.
export async function getRunEstimate(workflowId: string): Promise<RunCostEstimate> {
  const body = await apiGet<Record<string, unknown>>(
    `/api/v1/runs/estimate?workflow_id=${encodeURIComponent(workflowId)}`,
  )
  const atMost = minorOrNull(body.at_most_minor)
  if (atMost === null) throw new Error("The cost estimate is unavailable")
  return {
    atMostMinor: atMost,
    usuallyMinor: minorOrNull(body.usually_minor),
    sampleRuns: minorOrNull(body.sample_runs) ?? 0,
    unpricedCalls: minorOrNull(body.unpriced_calls) ?? 0,
  }
}

export async function getWorkflowSafeguards(id: string): Promise<WorkflowSafeguards> {
  const { data, etag } = await apiGetWithEtag<SafeguardsResponse>(
    `/api/v1/workflows/${encodeURIComponent(id)}/safeguards`,
  )
  return {
    workspace: {
      containsPii: data.workspace?.contains_pii === true,
      approveExternalActions: data.workspace?.approve_external_actions === true,
    },
    additions: safeguardSet(data.additions),
    effective: safeguardSet(data.effective),
    ...(etag === undefined ? {} : { etag }),
  }
}

export async function updateWorkflowSafeguards(
  id: string,
  additions: WorkflowSafeguards["additions"],
  etag: string | undefined,
): Promise<WorkflowSafeguards> {
  await apiPut<unknown>(
    `/api/v1/workflows/${encodeURIComponent(id)}/safeguards`,
    {
      additions: {
        customer_visible: additions.customerVisible,
        contains_pii: additions.containsPii,
        approve_external_actions: additions.approveExternalActions,
      },
    },
    // The route requires If-Match over the whole view, so a save made against
    // a stale workspace rule is refused rather than silently applied.
    etag === undefined ? {} : { ifMatch: etag },
  )
  return getWorkflowSafeguards(id)
}

function safeguardSet(value: SafeguardSet | undefined): WorkflowSafeguards["additions"] {
  return {
    customerVisible: value?.customer_visible === true,
    containsPii: value?.contains_pii === true,
    approveExternalActions: value?.approve_external_actions === true,
  }
}

export async function createWorkflow(goal: string): Promise<Workflow> {
  return mapWorkflow(await apiPost<unknown>("/api/v1/workflows", { goal }, {
    idempotencyKey: mutationKey("workflow-create"),
  }))
}

export async function saveWorkflowGraph(id: string, graph: { nodes: any[]; edges: any[]; successCriteria?: string[] }): Promise<void> {
  await apiPatch(
    `/api/v1/workflows/${encodeURIComponent(id)}`,
    { dag: compileDag(graph.nodes, graph.edges, graph.successCriteria) },
    { idempotencyKey: mutationKey("workflow-save") },
  )
}

export async function getNodeTypes(): Promise<NodeTypeDefinition[]> {
  const body = await apiGet<unknown>("/api/v1/node-types")
  return asArray(body, "node_types").map(mapNodeType)
}

export async function workflowAction(id: string, action: string, body: unknown = {}): Promise<unknown> {
  return apiPost(`/api/v1/workflows/${encodeURIComponent(id)}/actions/${action}`, body, {
    idempotencyKey: mutationKey(`workflow-${action}`),
  })
}

// C8: a workflow's deployment history. Versions come back newest first and
// carry the status the lifecycle service moves them through -- compiled,
// tested, canary, promoted, rolled_back, retired.
export async function getWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
  const body = await apiGet<unknown>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/versions?limit=50`,
  )
  return asArray(body, "data").map(mapWorkflowVersion)
}

// A deployment starts here: promote and canary each refuse a version that
// has not been tested.
export async function testWorkflowVersion(
  workflowId: string,
  workflowVersionId: string,
): Promise<void> {
  await apiPost(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/actions/test-version`,
    { workflowVersionId },
    { idempotencyKey: mutationKey("workflow-test-version") },
  )
}

export async function promoteWorkflowVersion(
  workflowId: string,
  workflowVersionId: string,
): Promise<void> {
  await apiPost(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/actions/promote-version`,
    { workflowVersionId },
    { idempotencyKey: mutationKey("workflow-promote-version") },
  )
}

export async function startWorkflowVersionCanary(
  workflowId: string,
  workflowVersionId: string,
  trafficPercent: number,
): Promise<void> {
  await apiPost(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/actions/start-canary`,
    { workflowVersionId, trafficPercent },
    { idempotencyKey: mutationKey("workflow-start-canary") },
  )
}

export async function rollbackWorkflowVersion(
  workflowId: string,
  workflowVersionId: string,
): Promise<void> {
  await apiPost(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/actions/rollback`,
    { workflowVersionId },
    { idempotencyKey: mutationKey("workflow-rollback") },
  )
}

function mapWorkflowVersion(item: AnyRecord): WorkflowVersion {
  return {
    id: asString(item.id),
    version: Number(item.version ?? 0),
    status: mapWorkflowVersionStatus(item.status),
    dagSchemaVersion: String(item.dagSchemaVersion ?? item.dag_schema_version ?? ""),
    trafficPercent:
      item.trafficPercent ?? item.traffic_percent ?? null,
    evaluationRunId: item.evaluationRunId ?? item.evaluation_run_id ?? null,
    testedAt: item.testedAt ?? item.tested_at ?? null,
    evaluationFailedAt: item.evaluationFailedAt ?? item.evaluation_failed_at ?? null,
    createdAt: asDate(item.createdAt ?? item.created_at),
  }
}

function mapWorkflowVersionStatus(value: unknown): WorkflowVersion["status"] {
  return value === "compiled" ||
    value === "tested" ||
    value === "canary" ||
    value === "promoted" ||
    value === "rolled_back" ||
    value === "retired"
    ? value
    : "compiled"
}

export async function getRuns(): Promise<Run[]> {
  const body = await apiGet<unknown>("/api/v1/runs")
  return asArray(body, "runs").map(mapRun)
}

export async function getRun(id: string): Promise<Run> {
  const body = await apiGet<unknown>(`/api/v1/runs/${encodeURIComponent(id)}`)
  return mapRun((body as AnyRecord)?.run ?? body)
}

export async function retryRun(id: string, nodeKey: string): Promise<Run> {
  await apiPost(`/api/v1/runs/${encodeURIComponent(id)}/actions/retry-node`, { node_key: nodeKey }, {
    idempotencyKey: mutationKey("run-retry"),
  })
  return getRun(id)
}

export async function stopRun(id: string): Promise<void> {
  await apiPost(`/api/v1/runs/${encodeURIComponent(id)}/actions/cancel`, {}, {
    idempotencyKey: mutationKey("run-cancel"),
  })
}

// recovery_actions.strategy (repair/retry/backoff/swap_agent/escalate_model/
// recompile/replan/degrade/ask_user/terminate -- 0014_create_recovery_actions.sql)
// is a wider vocabulary than RecoveryEvent.type's 6 values, so this is a
// best-effort grouping, not a lossless mapping: automated retry-shaped
// strategies collapse onto "retry", plan/DAG-rebuilding strategies onto
// "rollback", "degrade" onto "skip" (still doing the work, just less of
// it), ask_user onto "human_decision", terminate onto "abort".
const recoveryStrategyToType: Record<string, RecoveryEvent["type"]> = {
  retry: "retry",
  backoff: "retry",
  repair: "retry",
  swap_agent: "retry",
  escalate_model: "retry",
  recompile: "rollback",
  replan: "rollback",
  degrade: "skip",
  ask_user: "human_decision",
  terminate: "abort",
}

function mapRecoveryEvent(value: unknown): RecoveryEvent {
  const item = value as AnyRecord
  const strategy = String(item.strategy ?? "retry")
  const failureClass = typeof item.failure_class === "string" ? item.failure_class : "Failure"
  const outcome = typeof item.outcome === "string" ? item.outcome : undefined
  return {
    id: asString(item.id),
    runId: asString(item.run_id),
    nodeId: typeof item.node_execution_id === "string" ? item.node_execution_id : undefined,
    type: recoveryStrategyToType[strategy] ?? "retry",
    // recovery_actions has no actor/created_by column -- these are always
    // automated recovery-policy decisions, never a human action.
    actor: { type: "system", name: "AlterX" },
    summary: `${failureClass} recovery via ${strategy}${outcome ? ` (${outcome})` : ""}`,
    createdAt: asDate(item.created_at ?? item.createdAt),
    metadata: {
      failure_class: item.failure_class,
      strategy: item.strategy,
      policy_version: item.policy_version,
      root_cause_estimate: item.root_cause_estimate,
    },
  }
}

export async function getRecoveryHistory(runId: string): Promise<RecoveryEvent[]> {
  const body = await apiGet<unknown>(`/api/v1/runs/${encodeURIComponent(runId)}/recovery-actions`)
  return asArray(body, "data").map(mapRecoveryEvent)
}

function mapVerificationVerdict(value: unknown): VerificationCheck["status"] {
  if (value === "pass") return "passed"
  if (value === "warn") return "warning"
  return "failed"
}

function aggregateVerificationStatus(checks: readonly VerificationCheck[]): VerificationStatus {
  if (checks.length === 0) return "not_run"
  if (checks.some((check) => check.status === "failed")) return "failed"
  if (checks.some((check) => check.status === "warning")) return "warning"
  return "passed"
}

// GET .../verification-results returns every gate-check for the WHOLE run
// (one row per node per gate_type -- 0013_create_verification_results.sql),
// not a single node's result, so this fetches the run's full list and
// filters to the requested node_execution_id client-side rather than
// guessing at a per-node backend route that doesn't exist.
export async function getNodeVerification(runId: string, nodeId: string): Promise<NodeVerification> {
  const body = await apiGet<unknown>(`/api/v1/runs/${encodeURIComponent(runId)}/verification-results`)
  const rows = asArray(body, "data").filter((row) => row.node_execution_id === nodeId)
  const checks: VerificationCheck[] = rows.map((row) => {
    const details = row.details as AnyRecord | undefined
    const message = details && typeof details === "object"
      ? (details.message ?? details.reason ?? details.summary)
      : undefined
    return {
      id: asString(row.id),
      name: String(row.gate_type ?? "check"),
      status: mapVerificationVerdict(row.verdict),
      message: typeof message === "string" ? message : undefined,
    }
  })
  const status = aggregateVerificationStatus(checks)
  const passedCount = checks.filter((check) => check.status === "passed").length
  return {
    status,
    summary: checks.length === 0
      ? "No verification results for this node yet."
      : `${passedCount}/${checks.length} checks passed`,
    checks,
  }
}

interface CredentialResponse {
  id: string
  name: string
  connector: string
  scope: string
  last4: string
  created_at: string
  version: string
}

function mapCredential(value: CredentialResponse): Credential {
  return {
    id: value.id,
    name: value.name,
    type: "secret",
    provider: value.connector,
    maskedValue: `••••${value.last4}`,
    createdAt: value.created_at,
    updatedAt: value.created_at,
    usedByConnectionIds: [],
  }
}

// Mirrors computeEtag in apps/platform-api/src/concurrency/etag.ts exactly:
// sha256("version:<version>") as base64url, quoted. PATCH /credentials/:id
// is @EtagConstrained() -- IfMatchGuard re-derives this same hash
// server-side from the current DB record's version and 412s anything else
// (apps/platform-api/src/concurrency/if-match.guard.ts). apiRequest's
// wrapper doesn't expose response headers (see api/http.ts), so this
// recomputes the value from the `version` field already in the GET body
// rather than reading a real ETag header off the wire.
async function computeCredentialEtag(version: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`version:${version}`))
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
  return `"${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}"`
}

export async function getCredentials(): Promise<Credential[]> {
  const body = await apiGet<CredentialResponse[]>("/api/v1/credentials")
  return body.map(mapCredential)
}

export async function getCredential(id: string): Promise<Credential> {
  const body = await apiGet<CredentialResponse>(`/api/v1/credentials/${encodeURIComponent(id)}`)
  return mapCredential(body)
}

export async function createCredential(data: {
  name: string
  connector: string
  scope: string
  value: string
}): Promise<Credential> {
  const body = await apiPost<CredentialResponse>("/api/v1/credentials", data, {
    idempotencyKey: mutationKey("credential-create"),
  })
  return mapCredential(body)
}

// updateCredential (metadata) and replaceCredentialSecret (secret rotation)
// share this: there is no separate rotate-secret backend route, both go
// through the same PATCH with different fields populated (see
// credential.controller.ts / validation.ts's updateSchema, .strict() --
// only name/connector/scope/value are ever accepted, so callers must not
// pass any other key).
async function patchCredential(
  id: string,
  data: { name?: string; connector?: string; scope?: string; value?: string },
): Promise<Credential> {
  const encodedId = encodeURIComponent(id)
  const current = await apiGet<CredentialResponse>(`/api/v1/credentials/${encodedId}`)
  const body = await apiPatch<CredentialResponse>(`/api/v1/credentials/${encodedId}`, data, {
    idempotencyKey: mutationKey("credential-update"),
    ifMatch: await computeCredentialEtag(current.version),
  })
  return mapCredential(body)
}

export async function updateCredential(
  id: string,
  data: { name?: string; connector?: string; scope?: string },
): Promise<Credential> {
  return patchCredential(id, data)
}

export async function replaceCredentialSecret(id: string, secretValue: string): Promise<Credential> {
  return patchCredential(id, { value: secretValue })
}

export async function deleteCredential(id: string): Promise<void> {
  await apiDelete(`/api/v1/credentials/${encodeURIComponent(id)}`, {
    idempotencyKey: mutationKey("credential-delete"),
  })
}

export async function getArtifact(id: string): Promise<Artifact> {
  return mapArtifact(await apiGet<unknown>(`/api/v1/artifacts/${encodeURIComponent(id)}`))
}

/** Every artifact the workspace's runs produced, newest first (first 200). */
export async function getArtifacts(): Promise<Artifact[]> {
  const body = await apiGet<unknown>("/api/v1/artifacts?limit=200")
  return asArray(body, "data").map(mapArtifact)
}

export async function getArtifactsByRun(runId: string): Promise<Artifact[]> {
  const run = await apiGet<AnyRecord>(`/api/v1/runs/${encodeURIComponent(runId)}`)
  return asArray(run, "artifacts").map(mapArtifact)
}

export async function getProjects(): Promise<Project[]> {
  const body = await apiGet<unknown>("/api/v1/projects")
  return asArray(body, "projects").map(mapProject)
}

/** The engine's name search over every project in the workspace (task B3.4). */
export async function searchProjects(query: string, limit: number): Promise<Project[]> {
  const body = await apiGet<unknown>(`/api/v1/projects?q=${encodeURIComponent(query)}&limit=${limit}`)
  return asArray(body, "projects").map(mapProject)
}

export async function getProject(id: string): Promise<Project> {
  return mapProject(await apiGet<unknown>(`/api/v1/projects/${encodeURIComponent(id)}`))
}

export async function createProject(goal: string): Promise<Project> {
  return mapProject(await apiPost<unknown>("/api/v1/projects", { brief: goal }, {
    idempotencyKey: mutationKey("project-create"),
  }))
}

export async function getProjectBuild(id: string): Promise<Run> {
  const body = await apiGet<unknown>(`/api/v1/projects/${encodeURIComponent(id)}/builds`)
  return mapRun(asArray(body, "builds")[0] ?? body)
}

export async function startProjectBuild(id: string): Promise<{ runId: string }> {
  const body = await apiPost<AnyRecord>(`/api/v1/projects/${encodeURIComponent(id)}/builds`, {}, {
    idempotencyKey: mutationKey("project-build"),
  })
  return { runId: String(body.run_id ?? body.runId ?? body.build_id ?? body.id ?? "") }
}

// The planner asks these while a project's plan is still being written; the
// engine keeps them on the plan's conversation and answers the open ones
// only. `options` is always empty -- no option vocabulary exists anywhere
// behind this -- so an answer is free text.
export async function getProjectClarifications(id: string): Promise<ProjectClarification[]> {
  const body = await apiGet<unknown>(`/api/v1/projects/${encodeURIComponent(id)}/clarifications`)
  return asArray(body, "data").map((item) => ({
    id: String(item.clarification_id ?? item.id ?? ""),
    question: String(item.question ?? ""),
    required: item.required !== false,
  }))
}

export async function answerProjectClarification(
  id: string,
  clarificationId: string,
  answer: string,
): Promise<void> {
  await apiPost(
    `/api/v1/projects/${encodeURIComponent(id)}/clarifications/${encodeURIComponent(clarificationId)}/answer`,
    { answer },
    { idempotencyKey: mutationKey("project-clarification-answer") },
  )
}

export async function approveProjectPlan(id: string): Promise<void> {
  await apiPost(`/api/v1/projects/${encodeURIComponent(id)}/plan/actions/approve`, {}, {
    idempotencyKey: mutationKey("project-plan-approve"),
  })
}

export async function getProjectFiles(id: string): Promise<ProjectFile[]> {
  const body = await apiGet<unknown>(`/api/v1/projects/${encodeURIComponent(id)}/repository`)
  return asArray(body, "files").map(mapProjectFile)
}

export async function getProjectTests(id: string): Promise<TestResult[]> {
  const body = await apiGet<unknown>(`/api/v1/projects/${encodeURIComponent(id)}/tests`)
  return asArray(body, "tests").map(mapTest)
}

export async function getProjectAudit(id: string): Promise<{ category: string; status: string; message: string }[]> {
  const body = await apiGet<unknown>(`/api/v1/projects/${encodeURIComponent(id)}/audit-results`)
  return asArray(body, "results").map((item) => ({
    category: String(item.category ?? item.type ?? "Audit"),
    status: String(item.status ?? item.result ?? "unknown"),
    message: String(item.message ?? item.summary ?? ""),
  }))
}

export async function getProjectPreview(id: string): Promise<{ url: string; status: string }> {
  const body = await apiGet<AnyRecord>(`/api/v1/projects/${encodeURIComponent(id)}/previews`)
  const preview = asArray(body, "previews")[0] ?? body
  return { url: String(preview.url ?? preview.preview_url ?? "about:blank"), status: String(preview.status ?? "ready") }
}

export async function getTriggers(workflowId: string): Promise<Trigger[]> {
  const body = await apiGet<unknown>(`/api/v1/triggers?workflowId=${encodeURIComponent(workflowId)}`)
  return asArray(body, "triggers")
    .filter((item) => item.status !== "archived")
    .map(mapTrigger)
}

export async function getTrigger(id: string): Promise<Trigger> {
  return mapTrigger(await apiGet<unknown>(`/api/v1/triggers/${encodeURIComponent(id)}`))
}

export async function createTrigger(data: Partial<Trigger>): Promise<Trigger> {
  const body = await apiPost<AnyRecord>("/api/v1/triggers", backendTrigger(data), {
    idempotencyKey: mutationKey("trigger-create"),
  })
  return mapTrigger(body.trigger ?? body)
}

export async function updateTrigger(id: string, data: Partial<Trigger>): Promise<Trigger> {
  if (data.enabled === undefined) {
    throw new Error("Trigger updates require an enabled state")
  }
  return setTriggerStatus(id, data.enabled ? "enabled" : "disabled")
}

async function setTriggerStatus(id: string, status: "enabled" | "disabled" | "archived"): Promise<Trigger> {
  const path = `/api/v1/triggers/${encodeURIComponent(id)}`
  const current = await apiGetWithEtag<unknown>(path)
  if (!current.etag) {
    throw new Error("Trigger ETag missing")
  }
  return mapTrigger(await apiPatch(`${path}/status`, { status }, {
    idempotencyKey: mutationKey("trigger-status"),
    ifMatch: current.etag,
  }))
}

export async function testTrigger(id: string): Promise<{ success: boolean; message: string; eventId?: string }> {
  const body = await apiPost<AnyRecord>(`/api/v1/triggers/${encodeURIComponent(id)}/actions/test`, {}, {
    idempotencyKey: mutationKey("trigger-test"),
  })
  const eventId = body?.eventId ?? body?.event_id
  if (typeof eventId !== "string" || !eventId.startsWith("evt_")) {
    throw new Error("No test event was returned")
  }
  return { success: true, message: "Test event recorded.", eventId }
}

export async function enableTrigger(id: string): Promise<Trigger> {
  return mapTrigger(await apiPost(`/api/v1/triggers/${encodeURIComponent(id)}/actions/enable`, {}, {
    idempotencyKey: mutationKey("trigger-enable"),
  }))
}

export async function disableTrigger(id: string): Promise<Trigger> {
  return setTriggerStatus(id, "disabled")
}

export async function removeTrigger(id: string): Promise<void> {
  await setTriggerStatus(id, "archived")
}

export async function getEvents(filters?: any): Promise<IncomingEvent[]> {
  const query = new URLSearchParams(filters ?? {})
  const body = await apiGet<unknown>(`/api/v1/events${query.size ? `?${query}` : ""}`)
  return asArray(body, "events").map(mapEvent)
}

export async function getEvent(id: string): Promise<IncomingEvent> {
  return mapEvent(await apiGet<unknown>(`/api/v1/events/${encodeURIComponent(id)}`))
}

export async function replayEvent(id: string): Promise<EventReplayPreview> {
  return apiPost<EventReplayPreview>(`/api/v1/events/${encodeURIComponent(id)}/replay`, {})
}

export async function replayEventForReal(id: string, confirmationToken: string, requestKey = mutationKey("event-replay")): Promise<{ runId: string; replayedFrom: string }> {
  return apiPost(`/api/v1/events/${encodeURIComponent(id)}/replay-for-real`, { confirmed: true, confirmationToken },
    { idempotencyKey: requestKey })
}

export async function getWebhooks(): Promise<WebhookEndpoint[]> {
  return []
}

// ads-core's sources table only ever creates connector-backed sources for
// two real providers (drive, shopify -- src/ingestion/repository.py's
// create_source hardcodes this pair and rejects anything else). Of the
// frontend's 7 KnowledgeSourceType values, only "google_drive" has a real
// connector behind it; file_upload/website/notion/confluence/database/api
// have no creation path in the live backend at all yet -- rejected below
// with a clear message rather than silently creating a fake "drive"
// source for a type the user didn't ask for.
const CONNECTOR_BY_SOURCE_TYPE: Partial<Record<KnowledgeSourceType, "drive" | "shopify">> = {
  google_drive: "drive",
}

// Inverse of the above, for reading sources back -- "shopify" has no
// matching KnowledgeSourceType at all, so it falls back to "api" (the
// closest existing category) rather than a type that doesn't exist.
const SOURCE_TYPE_BY_PROVIDER: Record<string, KnowledgeSourceType> = {
  google_drive: "google_drive",
  shopify: "api",
}

export async function getKnowledgeSources(): Promise<KnowledgeSource[]> {
  // getKnowledgeSources()'s own return type is a flat array (no pagination
  // UI in knowledge-list.tsx), and 200 is the endpoint's own max page
  // size -- a workspace with more sources than that would silently see
  // only the first page here. Flagged as a known limit, not fixed by
  // looping pages, to match this function's existing flat-array contract.
  const body = await apiGet<unknown>("/api/v1/ads/sources?limit=200")
  return asArray(body, "data").map(mapKnowledgeSource)
}

/** One source's documents: metadata only, newest first (ads-core GET /ads/documents). */
export async function getKnowledgeDocuments(sourceId: string): Promise<KnowledgeDocument[]> {
  const body = await apiGet<unknown>(
    `/api/v1/ads/documents?limit=200&sourceId=${encodeURIComponent(sourceId)}`,
  )
  return asArray(body, "data").map(mapKnowledgeDocument)
}

export async function getKnowledgeSource(id: string): Promise<KnowledgeSource> {
  return mapKnowledgeSource(await apiGet<unknown>(`/api/v1/ads/sources/${encodeURIComponent(id)}/detail`))
}

export async function createKnowledgeSource(data: Partial<KnowledgeSource>): Promise<KnowledgeSource> {
  const type = data.type ?? "file_upload"
  const connector = CONNECTOR_BY_SOURCE_TYPE[type]
  if (!connector) {
    throw new Error(
      `Knowledge sources of type "${type}" aren't backed by a real connector yet -- only Google Drive-backed sources (type "google_drive") can be created through the live API today.`,
    )
  }
  const settings: AnyRecord = { ...(data.config ?? {}) }
  if (data.name) settings.name = data.name
  const body = await apiPost<unknown>("/api/v1/ads/sources", { connector, settings }, {
    idempotencyKey: mutationKey("knowledge-source-create"),
  })
  const created = body as AnyRecord
  // The create response (SourceResponse) is deliberately minimal (id,
  // scope_id, connector, status, created) -- it doesn't carry
  // document_count/chunk_count/sync_config, so re-fetch the real detail
  // read this same PR adds rather than fabricate zeros for a source that
  // was really just created.
  return getKnowledgeSource(asString(created.id))
}

export async function syncKnowledgeSource(id: string): Promise<KnowledgeSource> {
  // scheduled_sync's real response is a list of kicked-off ingestion jobs,
  // not a source -- re-read the source afterward for an honest current
  // state instead of guessing at one from that response shape.
  await apiPost(`/api/v1/ads/sources/${encodeURIComponent(id)}/actions/sync`, {}, {
    idempotencyKey: mutationKey("knowledge-source-sync"),
  })
  return getKnowledgeSource(id)
}

/** Erases the source and everything ingested through it (ads-core DELETE /ads/sources/:id). */
export async function deleteKnowledgeSource(id: string): Promise<void> {
  await apiDelete(`/api/v1/ads/sources/${encodeURIComponent(id)}`, {
    idempotencyKey: mutationKey("knowledge-source-delete"),
  })
}

export async function deleteKnowledgeDocument(id: string): Promise<void> {
  await apiDelete(`/api/v1/ads/documents/${encodeURIComponent(id)}`, {
    idempotencyKey: mutationKey("knowledge-document-delete"),
  })
}

export async function retryKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
  const body = await apiPost<AnyRecord>(`/api/v1/ads/documents/${encodeURIComponent(id)}/actions/reindex`, {}, {
    idempotencyKey: mutationKey("knowledge-document-reindex"),
  })
  // reindex re-chunks/re-embeds the document's already-stored content
  // synchronously and returns only once that finishes -- "indexed" and
  // chunkCount are real. sourceId/name/createdAt aren't in this response
  // (ReindexResponse has no document metadata, only version/chunk
  // counters) and there's no real single-document read yet to backfill
  // them from (see PR description) -- left honestly blank rather than
  // guessed. Safe today: document-list.tsx's retry mutation discards this
  // return value and refetches the document list instead of reading it.
  return {
    id: asString(body.document_id ?? id),
    sourceId: "",
    name: "",
    status: "indexed",
    chunkCount: Number(body.chunk_count ?? 0),
    createdAt: "",
  }
}

export async function testRetrieval(query: string, filters?: any): Promise<RetrievalResult[]> {
  const requestBody: AnyRecord = { query }
  if (Array.isArray(filters?.sources) && filters.sources.length) requestBody.source_ids = filters.sources
  if (typeof filters?.topK === "number") requestBody.top_k = filters.topK

  const response = await apiPost<AnyRecord>("/api/v1/ads/query", requestBody)
  const hits = Array.isArray(response.results) ? response.results : []
  if (hits.length === 0) return []

  // Real hits carry only source_id/document_id, no display name. Best-
  // effort enrichment using the real source list this PR also adds;
  // falls back to the bare id (honest, not fabricated) when a source
  // can't be resolved or the lookup itself fails.
  const sourceNames = await knowledgeSourceNames()

  return hits.map((hit: AnyRecord) => {
    const sourceId = asString(hit.source_id)
    const documentId = asString(hit.document_id)
    return {
      id: asString(hit.id ?? hit.chunk_id),
      chunkId: asString(hit.chunk_id),
      sourceId,
      documentId,
      content: asString(hit.text),
      score: Number(hit.score ?? 0),
      confidence: confidenceBucket(Number(hit.confidence ?? hit.score ?? 0)),
      provenance: [{
        id: asString(hit.chunk_id),
        sourceId,
        sourceName: sourceNames.get(sourceId) ?? sourceId,
        documentId,
        // No real document-name read exists yet (documents table has a
        // real `title` column, but nothing exposes it -- see PR
        // description) -- the raw id is the honest fallback.
        documentName: documentId,
      }],
    }
  })
}

async function knowledgeSourceNames(): Promise<Map<string, string>> {
  try {
    const sources = await getKnowledgeSources()
    return new Map(sources.map((source) => [source.id, source.name]))
  } catch {
    return new Map()
  }
}

function confidenceBucket(value: number): "high" | "medium" | "low" {
  if (value >= 0.8) return "high"
  if (value >= 0.5) return "medium"
  return "low"
}

const DOCUMENT_STATUSES = new Set(["queued", "processing", "indexed", "failed", "excluded"])

function mapKnowledgeDocument(value: unknown): KnowledgeDocument {
  const item = value as AnyRecord
  const raw = typeof item.status === "string" ? item.status : ""
  const status = (DOCUMENT_STATUSES.has(raw) ? raw : "indexed") as KnowledgeDocument["status"]
  return {
    id: asString(item.id),
    sourceId: asString(item.source_id),
    name: typeof item.title === "string" && item.title.length > 0 ? item.title : asString(item.id),
    status,
    createdAt: asString(item.created_at),
    ...(status === "indexed" && typeof item.updated_at === "string" ? { indexedAt: item.updated_at } : {}),
  }
}

function mapKnowledgeSource(value: unknown): KnowledgeSource {
  const item = value as AnyRecord
  const config = (item.sync_config ?? {}) as AnyRecord
  const provider = String(item.provider ?? "")
  const name = typeof config.name === "string" && config.name.length > 0 ? config.name : asString(item.id)
  return {
    id: asString(item.id),
    name,
    type: SOURCE_TYPE_BY_PROVIDER[provider] ?? "api",
    // The sources table has no real syncing/processing/failed/paused
    // state machine -- status is always "active" (see PR description).
    // "ready" is the least-wrong reading of that single real value.
    status: "ready",
    documentCount: Number(item.document_count ?? 0),
    chunkCount: Number(item.chunk_count ?? 0),
    lastSyncedAt: typeof item.last_sync_at === "string" ? item.last_sync_at : undefined,
    // nextSyncAt intentionally omitted -- sync is caller-triggered only,
    // there is no scheduled-sync concept anywhere in ads-core.
    createdAt: asDate(item.created_at),
    updatedAt: asDate(item.updated_at ?? item.created_at),
    connectionId: typeof item.integration_ref === "string" ? item.integration_ref : undefined,
    config,
  }
}

// The real catalog (ConnectorCatalogEntry) has no category concept at
// all -- this is a UI grouping choice over the fixed, known set of real
// connector ids (apps/platform-api/src/integrations/connectors.ts), not
// data read from the backend. Anything not listed here (there shouldn't
// be any) falls back to "Other".
const INTEGRATION_CATEGORY_BY_CONNECTOR: Record<string, IntegrationCategory> = {
  github: "Development",
  google: "Productivity",
  slack: "Communication",
  hubspot: "CRM",
  linkedin: "Communication",
  zendesk: "CRM",
  salesforce: "CRM",
  shopify: "Data",
  x: "Communication",
  m365: "Productivity",
}

export async function getIntegrationCatalog(): Promise<IntegrationDefinition[]> {
  const body = await apiGet<unknown>("/api/v1/integrations")
  return asArray(body, "data").map(mapIntegrationDefinition)
}

export async function getIntegration(id: string): Promise<IntegrationDefinition> {
  // No dedicated single-entry route exists -- catalog() is the only real
  // read, and it's a short, fully-loaded list (one entry per connector
  // this deployment supports), so filtering client-side is the correct
  // match for the one real caller (connection-detail.tsx, one id at a
  // time) rather than a cost worth avoiding.
  const catalog = await getIntegrationCatalog()
  const found = catalog.find((integration) => integration.id === id)
  if (!found) throw new Error("Integration not found")
  return found
}

export async function getConnections(): Promise<Connection[]> {
  const [body, nameByConnector] = await Promise.all([
    apiGet<unknown>("/api/v1/integrations/connections"),
    connectorNames(),
  ])
  return asArray(body, "data").map((item) => mapConnection(item, nameByConnector))
}

export async function getConnection(id: string): Promise<Connection> {
  const [item, nameByConnector] = await Promise.all([
    apiGet<unknown>(`/api/v1/integrations/connections/${encodeURIComponent(id)}`),
    connectorNames(),
  ])
  return mapConnection(item, nameByConnector)
}

export async function testConnection(id: string): Promise<{ success: boolean; message: string }> {
  // health() (POST .../actions/health) returns a full OAuthConnectionView,
  // not {success, message} -- but last_health_status is unambiguous: the
  // real service sets it to exactly "healthy" or "unhealthy"
  // (integration.service.ts's health()), never anything else. success
  // and message both derive cleanly from that one real field.
  const body = await apiPost<AnyRecord>(
    `/api/v1/integrations/connections/${encodeURIComponent(id)}/actions/health`,
    {},
    { idempotencyKey: mutationKey("connection-health-check") },
  )
  const healthy = body.last_health_status === "healthy"
  return {
    success: healthy,
    message: healthy
      ? "Connection test successful."
      : "Connection test failed -- the provider rejected the stored credentials.",
  }
}

export async function deleteConnection(id: string): Promise<void> {
  // Real remote revoke (integration.service.ts's revoke()) -- calls the
  // provider's own revoke endpoint when the connector has real client
  // credentials configured, then invalidates the connection locally
  // either way. This is the correct backend action for "delete this
  // connection," not a scope mismatch.
  await apiPost(
    `/api/v1/integrations/connections/${encodeURIComponent(id)}/actions/revoke`,
    {},
    { idempotencyKey: mutationKey("connection-revoke") },
  )
}

async function connectorNames(): Promise<Map<string, string>> {
  try {
    const catalog = await getIntegrationCatalog()
    return new Map(catalog.map((integration) => [integration.id, integration.name]))
  } catch {
    return new Map()
  }
}

function mapIntegrationDefinition(value: unknown): IntegrationDefinition {
  const item = value as AnyRecord
  const id = asString(item.id)
  const name = asString(item.display_name ?? id)
  return {
    id,
    name,
    category: INTEGRATION_CATEGORY_BY_CONNECTOR[id] ?? "Other",
    // No real description field exists on the catalog entry either --
    // a plain, factual sentence rather than a fabricated marketing blurb.
    description: `Connect your ${name} account via OAuth.`,
    // Real OAuth scope strings, not curated "capability" labels -- honest
    // (they genuinely are what this connection can access), if more
    // technical-looking than the mock data's phrasing.
    capabilities: Array.isArray(item.scopes) ? item.scopes.map((scope: unknown) => String(scope)) : [],
    // Every real connector here is OAuth-based; there is no other auth
    // type in this system.
    authType: "oauth",
    available: Boolean(item.configured),
  }
}

function mapConnection(value: unknown, nameByConnector: Map<string, string>): Connection {
  const item = value as AnyRecord
  const connector = asString(item.connector)
  return {
    id: asString(item.id),
    integrationId: connector,
    // No per-connection display name exists on the backend record at all
    // -- createConnection isn't wired to a real name-capturing flow yet
    // (see PR description), so there is nothing real to read here. The
    // connector's own real display name is used as an honest stand-in
    // rather than a fabricated one, falling back to the bare connector id
    // if even that lookup fails.
    name: nameByConnector.get(connector) ?? connector,
    status: mapConnectionStatus(String(item.status ?? "connected"), item.last_health_status),
    createdAt: asDate(item.created_at),
    // The backend's "version" field is literally the record's
    // updated_at, ISO-formatted (see integration.service.ts's project())
    // -- not a version counter despite the name.
    updatedAt: asDate(item.version ?? item.created_at),
    lastCheckedAt: typeof item.last_health_checked_at === "string" ? item.last_health_checked_at : undefined,
    metadata:
      typeof item.external_account_id === "string"
        ? { externalAccountId: item.external_account_id }
        : undefined,
  }
}

// The real status enum is only connected/revoked/error -- 3 values
// against the frontend's 5. "degraded" IS derivable (a connected
// connection whose last real health check came back "unhealthy" --
// last_health_status is only ever null/"healthy"/"unhealthy", see
// integration.service.ts's health()). "expired" is NOT derivable: no
// token-expiry timestamp is exposed anywhere on OAuthConnectionView, so
// it is never produced here rather than guessed at.
function mapConnectionStatus(status: string, healthStatus: unknown): Connection["status"] {
  if (status === "error") return "error"
  if (status === "revoked") return "disconnected"
  if (healthStatus === "unhealthy") return "degraded"
  return "connected"
}

export async function getWhatsAppChannels(): Promise<WhatsAppChannel[]> {
  const body = await apiGet<unknown>("/api/v1/channels/whatsapp/accounts")
  return asArray(body, "accounts").map(mapWhatsAppChannel)
}

export function getWhatsAppTemplates(id: string): Promise<WhatsAppTemplate[]> {
  return apiGet(`/api/v1/channels/whatsapp/accounts/${encodeURIComponent(id)}/templates`)
}

export function testWhatsAppChannel(id: string, message: WhatsAppTestMessage, requestKey: string): Promise<{ messageId: string }> {
  return apiPost(`/api/v1/channels/whatsapp/accounts/${encodeURIComponent(id)}/test-send`, message, { idempotencyKey: requestKey })
}

// The real create body (CreateWhatsappAccountInput: workspaceId,
// phoneNumberId, wabaId, accessTokenRef) shares no field with
// Partial<WhatsAppChannel> at all -- phoneNumberId is Meta's opaque
// numeric phone ID, not the E.164 phoneNumber the frontend type has; the
// WABA id and the access-token secret reference have no frontend
// equivalent whatsoever (there is no phone-number/business-account
// onboarding UI yet to collect them -- see PR description). Rather than
// invent values for fields the frontend has never modeled, callers must
// supply them as extra properties on `data`; the real endpoint's own
// strict validation rejects a request that's missing them with a clear
// field-level error instead of this function guessing.
export async function createWhatsAppChannel(data: Partial<WhatsAppChannel>): Promise<WhatsAppChannel> {
  const input = data as AnyRecord
  const body = {
    workspaceId: input.workspaceId,
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessTokenRef: input.accessTokenRef,
  }
  const created = await apiPost<unknown>("/api/v1/channels/whatsapp/accounts", body, {
    idempotencyKey: mutationKey("whatsapp-channel-create"),
  })
  return mapWhatsAppChannel(created)
}

/** Removes the account from this workspace; inbound messages for its number stop routing. */
export async function deleteWhatsAppChannel(id: string): Promise<void> {
  await apiDelete(`/api/v1/channels/whatsapp/accounts/${encodeURIComponent(id)}`, {
    idempotencyKey: mutationKey("whatsapp-channel-delete"),
  })
}

function mapWhatsAppChannel(value: unknown): WhatsAppChannel {
  const item = value as AnyRecord
  const phoneNumberId = asString(item.phoneNumberId)
  return {
    id: asString(item.id),
    // No display name exists on the real account record -- the Meta
    // phone number id is the closest real identifier, used honestly
    // rather than a fabricated label.
    name: phoneNumberId,
    // Not the same thing as a real E.164 phone number -- Meta's
    // phoneNumberId is an opaque numeric id, and the real account record
    // has no separate E.164 field at all. Surfaced as-is (not formatted
    // to look like a phone number) so it isn't mistaken for one.
    phoneNumber: phoneNumberId,
    // The real status column is only ever "connected"/"disconnected" --
    // see WhatsappAccount in whatsapp.service.ts. "pending"/"degraded"
    // are never produced (no real signal backs them here).
    status: item.status === "disconnected" ? "disconnected" : "connected",
    // This whole integration is built on MetaCloudApiWhatsappProvider --
    // there is no other real provider behind it.
    provider: "meta",
    connectionId: typeof item.connectionId === "string" ? item.connectionId : undefined,
    // WhatsappAccount has no createdAt column at all -- not fabricated;
    // left as the current time is wrong (implies just-created), so this
    // uses an empty string rather than a plausible-looking wrong date.
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
  }
}

function asArray(value: unknown, key: string): AnyRecord[] {
  if (Array.isArray(value)) return value as AnyRecord[]
  const record = (value ?? {}) as AnyRecord
  if (Array.isArray(record[key])) return record[key]
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.items)) return record.items
  return []
}

function mapWorkspace(value: unknown): Workspace {
  const item = value as AnyRecord
  const name = String(item.name ?? "Workspace")
  return {
    id: asString(item.id ?? item.workspace_id),
    name,
    slug: String(item.slug ?? slugify(name)),
    role: mapRole(item.role ?? item.roles?.[0]),
    memberCount: Number(item.memberCount ?? item.member_count ?? 0),
    createdAt: asDate(item.createdAt ?? item.created_at ?? item.updatedAt ?? item.updated_at),
  }
}

function mapTenantRole(value: unknown): TenantDataResidencySettings["role"] {
  if (value === "owner" || value === "admin" || value === "billing") return value
  return "member"
}

function mapTenantDataResidency(
  value: TenantDataResidencyResponse["data_residency"],
): TenantDataResidency | null {
  if (value === null) return null
  if (!value || !Array.isArray(value.allowed)) {
    throw new Error("Tenant data residency response is malformed")
  }
  const allowed = value.allowed
  if (
    allowed.length < 1 ||
    allowed.length > 32 ||
    allowed.some((code) => typeof code !== "string" || code.trim().length === 0) ||
    (value.legal_basis !== undefined &&
      (typeof value.legal_basis !== "string" || value.legal_basis.trim().length === 0))
  ) {
    throw new Error("Tenant data residency response is malformed")
  }
  return {
    allowed: allowed.map((code) => (code as string).trim()),
    ...(typeof value.legal_basis === "string"
      ? { legalBasis: value.legal_basis.trim() }
      : {}),
  }
}

function mapMember(value: unknown): Member {
  const item = value as AnyRecord
  const email = String(item.email ?? item.invited_email ?? "")
  return {
    id: asString(item.id ?? item.user_id ?? item.memberId),
    name: String(item.name ?? item.displayName ?? item.display_name ?? email.split("@")[0] ?? "Member"),
    email,
    role: mapRole(item.role),
    status: String(item.status ?? "active") as Member["status"],
    joinedAt: asDate(item.joinedAt ?? item.joined_at ?? item.createdAt ?? item.created_at),
    avatarUrl: item.avatarUrl ?? item.avatar_url,
  }
}

function mapSession(value: unknown): Session {
  const item = value as AnyRecord
  return {
    id: asString(item.id ?? item.sessionId ?? item.session_id),
    device: String(item.device ?? item.deviceInfo?.device ?? "Unknown device"),
    browser: String(item.browser ?? item.deviceInfo?.browser ?? item.deviceInfo?.userAgent ?? "Unknown browser"),
    location: String(item.location ?? "Unknown"),
    ip: String(item.ip ?? ""),
    lastActive: asDate(item.lastActive ?? item.last_active_at ?? item.createdAt ?? item.created_at),
    isCurrent: Boolean(item.isCurrent ?? item.is_current ?? false),
  }
}

function mapWorkflow(value: unknown): Workflow {
  const item = value as AnyRecord
  return {
    id: asString(item.id ?? item.workflow_id),
    name: String(item.name ?? item.title ?? item.goal ?? "Untitled workflow"),
    description: item.description ?? item.summary,
    status: mapWorkflowStatus(item.status),
    runs: Number(item.runs ?? item.run_count ?? 0),
    successRate: Number(item.successRate ?? item.success_rate ?? 0),
    updatedAt: asDate(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at),
    dag: item.dag ?? undefined,
  }
}

// Inspector reads config fields as node.data[key] with an optional
// { label, default } describing each -- not raw JSON Schema. Adapt the
// registry's JSON Schema config_schema_json into that flat shape.
function mapNodeType(value: unknown): NodeTypeDefinition {
  const item = value as AnyRecord
  let configSchema: Record<string, { label: string; default?: unknown }> = {}
  try {
    const parsed = JSON.parse(String(item.config_schema_json ?? "{}")) as AnyRecord
    const properties = (parsed.properties ?? {}) as AnyRecord
    configSchema = Object.fromEntries(
      Object.keys(properties).map((key) => [key, { label: key }]),
    )
  } catch {
    configSchema = {}
  }
  return {
    type: asString(item.type),
    name: String(item.display_name ?? item.type),
    description: String(item.description ?? ""),
    category: String(item.category ?? "execution"),
    inputs: [],
    outputs: [],
    configSchema,
  }
}

function mapRun(value: unknown): Run {
  const item = value as AnyRecord
  const workflowId = item.workflowId ?? item.workflow_id
  const projectId = item.projectId ?? item.project_id
  return {
    id: asString(item.id ?? item.run_id ?? item.build_id),
    workflowId,
    workflowName: item.workflowName ?? item.workflow_name,
    projectId,
    projectName: item.projectName ?? item.project_name,
    mode: projectId ? "project" : "workflow",
    status: mapRunStatus(item.status),
    startedAt: item.startedAt ?? item.started_at,
    completedAt: item.completedAt ?? item.completed_at,
    durationMs: item.durationMs ?? item.duration_ms,
    nodeCount: item.nodeCount ?? item.node_count,
    currentNodeId: item.currentNodeId ?? item.current_node_id,
    createdAt: asDate(item.createdAt ?? item.created_at ?? item.startedAt ?? item.started_at),
  }
}

function mapProject(value: unknown): Project {
  const item = value as AnyRecord
  const brief = item.brief
  return {
    id: asString(item.id ?? item.project_id),
    name: String(item.name ?? item.title ?? (typeof brief === "string" ? brief.slice(0, 60) : "Untitled project")),
    status: mapProjectStatus(item.status),
    brief: typeof brief === "object" ? brief : brief ? { goal: String(brief), primaryUsers: "", coreCapabilities: [] } : undefined,
    plan: item.plan,
    createdAt: asDate(item.createdAt ?? item.created_at),
    updatedAt: asDate(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at),
  }
}

function mapArtifact(value: unknown): Artifact {
  const item = value as AnyRecord
  return {
    id: asString(item.id ?? item.artifact_id),
    runId: asString(item.runId ?? item.run_id),
    nodeId: item.nodeId ?? item.node_id,
    name: String(item.name ?? item.filename ?? "Artifact"),
    type: String(item.type ?? "file") as Artifact["type"],
    mimeType: item.mimeType ?? item.mime_type ?? item.contentType ?? item.content_type,
    sizeBytes: item.sizeBytes ?? item.size_bytes,
    createdAt: asDate(item.createdAt ?? item.created_at),
    previewUrl: item.previewUrl ?? item.preview_url,
    downloadUrl: item.downloadUrl ?? item.download_url,
    metadata: item.metadata,
  }
}

function mapProjectFile(value: unknown): ProjectFile {
  const item = value as AnyRecord
  const path = String(item.path ?? item.file_path ?? item.name ?? "")
  return {
    id: asString(item.id ?? path),
    path,
    name: String(item.name ?? path.split("/").pop() ?? path),
    type: String(item.type ?? "file") as ProjectFile["type"],
    language: item.language,
    status: item.status,
    content: item.content ?? item.diff,
  }
}

function mapTest(value: unknown): TestResult {
  const item = value as AnyRecord
  return {
    id: asString(item.id ?? item.test_id),
    name: String(item.name ?? item.title ?? "Test"),
    suite: item.suite,
    status: String(item.status ?? item.result ?? "skipped") as TestResult["status"],
    durationMs: item.durationMs ?? item.duration_ms,
    error: item.error ?? item.message,
  }
}

function mapTrigger(value: unknown): Trigger {
  const item = value as AnyRecord
  const status = String(item.status ?? "needs_configuration")
  return {
    id: asString(item.id ?? item.trigger_id),
    workflowId: asString(item.workflowId ?? item.workflow_id),
    type: (item.type === "cron" ? "schedule" : String(item.type ?? "webhook")) as Trigger["type"],
    name: String(item.name ?? "Trigger"),
    enabled: status === "enabled" || Boolean(item.enabled),
    status: (status === "enabled" || status === "disabled"
      ? "configured"
      : status === "draft" || status === "archived"
        ? "needs_configuration"
        : status) as Trigger["status"],
    config: item.config ?? {},
    lastTriggeredAt: item.lastTriggeredAt ?? item.last_triggered_at,
    lastTestedAt: item.lastTestedAt ?? item.last_tested_at,
    createdAt: asDate(item.createdAt ?? item.created_at),
    updatedAt: asDate(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at),
  }
}

function backendTrigger(data: Partial<Trigger>) {
  return {
    workspaceId: (data as AnyRecord).workspaceId,
    workflowId: data.workflowId,
    name: data.name,
    type: data.type,
    config: data.config ?? {},
  }
}

function mapEvent(value: unknown): IncomingEvent {
  const item = value as AnyRecord
  return {
    id: asString(item.id ?? item.event_id),
    source: String(item.source ?? "internal") as IncomingEvent["source"],
    type: String(item.type ?? item.event_type ?? "event"),
    status: String(item.status ?? "received") as IncomingEvent["status"],
    workflowId: item.workflowId ?? item.workflow_id,
    triggerId: item.triggerId ?? item.trigger_id,
    runId: item.runId ?? item.run_id,
    payload: item.payload ?? item.payload_inline ?? undefined,
    receivedAt: asDate(item.receivedAt ?? item.received_at ?? item.createdAt ?? item.created_at),
  }
}

function etagFromWorkspace(value: unknown) {
  const item = value as AnyRecord
  return `"${asDate(item.updatedAt ?? item.updated_at)}"`
}

function mapRole(value: unknown): WorkspaceRole {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer"
    ? value
    : "member"
}

function mapWorkflowStatus(value: unknown): Workflow["status"] {
  return value === "active" || value === "paused" || value === "archived" ? value : "draft"
}

function mapRunStatus(value: unknown): Run["status"] {
  if (value === "pending") return "queued"
  if (value === "paused") return "waiting"
  if (value === "cancelled" || value === "failed" || value === "completed" || value === "running") return value
  return "queued"
}

function mapProjectStatus(value: unknown): Project["status"] {
  if (value === "planning" || value === "building" || value === "testing" || value === "completed" || value === "archived") return value
  if (value === "ready") return "ready"
  // What the projects row itself stores, now that the read routes exist.
  if (value === "active") return "active"
  return "draft"
}

function asString(value: unknown) {
  return String(value ?? "")
}

function asDate(value: unknown) {
  return typeof value === "string" ? value : value instanceof Date ? value.toISOString() : new Date().toISOString()
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

/**
 * The Human Actions tabs span three sources with different lifecycles:
 * approvals (pending/approved/rejected/expired), escalations
 * (open/claimed/resolved) and clarifications (open/answered/expired).
 * mapHumanActionStatus folds those into one vocabulary; a tab is a set of
 * folded statuses, so Open is pending approvals plus open escalations and
 * clarifications, and Resolved includes decisions that expired.
 */
export function humanActionInTab(status: HumanActionStatus, tab: string | undefined): boolean {
  if (!tab || tab === "all") return true
  if (tab === "resolved") return status === "resolved" || status === "expired" || status === "cancelled"
  return status === tab
}

// ponytail: loads the whole queue and filters by tab here. Fine at today's
// volumes; when it is not, give /api/v1/action-centre a status filter in
// this folded vocabulary and page on the server.
const HUMAN_ACTION_PAGE_LIMIT = 200
const HUMAN_ACTION_MAX_PAGES = 10

export async function getHumanActions(filters?: HumanActionFilters): Promise<HumanAction[]> {
  // The action centre's own status filter speaks approvals' vocabulary only
  // and drops escalations and clarifications when it is set, so the tab is
  // never sent to it.
  const items: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < HUMAN_ACTION_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(HUMAN_ACTION_PAGE_LIMIT) })
    if (cursor) query.set("cursor", cursor)
    const body = await apiGet<unknown>(`/api/v1/action-centre?${query.toString()}`)
    items.push(...asArray(body, "data"))
    const next = ((body as AnyRecord | undefined)?.page as AnyRecord | undefined)?.next_cursor
    if (typeof next !== "string" || next.length === 0) break
    cursor = next
  }
  return items
    .map(mapHumanAction)
    .filter((action) => humanActionInTab(action.status, filters?.status))
    .filter((action) => !filters?.type || action.type === filters.type)
}

export async function getHumanAction(id: string): Promise<HumanAction> {
  // One action, read directly: the id names its own family, so the action
  // centre reads it from the right engine collection. This used to load the
  // whole queue and search it, which missed anything past the first page.
  return mapHumanAction(await apiGet<unknown>(`/api/v1/action-centre/${encodeURIComponent(id)}`))
}

function mapAnnotation(value: unknown): HumanAnnotation {
  const item = value as AnyRecord
  return {
    id: asString(item.id),
    actionId: asString(item.item_id ?? item.actionId),
    // Backend only returns the raw created_by user id, no display name --
    // same fallback-label shape mapHumanAction already uses for
    // claimedBy/resolvedBy above.
    author: { id: asString(item.created_by), name: "Team Member" },
    text: String(item.note ?? item.text ?? ""),
    createdAt: asDate(item.created_at ?? item.createdAt),
  }
}

export async function getHumanActionHistory(type: HumanActionType, id: string): Promise<HumanAnnotation[]> {
  const body = await apiGet<unknown>(
    `/api/v1/action-items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/annotations`,
  )
  return asArray(body, "data").map(mapAnnotation)
}

export async function addHumanAnnotation(type: HumanActionType, id: string, note: string): Promise<HumanAnnotation> {
  const body = await apiPost<unknown>(
    `/api/v1/action-items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/annotations`,
    { note },
    { idempotencyKey: mutationKey("annotation-create") },
  )
  return mapAnnotation(body)
}

export async function approveHumanAction(id: string, payload?: any): Promise<HumanAction> {
  const body = await apiPost<unknown>(`/api/v1/approvals/${encodeURIComponent(id)}/actions/approve`, {
    note: payload?.comment,
  })
  return mapHumanAction({ source_type: "approval", item: body })
}

export async function rejectHumanAction(id: string, payload?: any): Promise<HumanAction> {
  const body = await apiPost<unknown>(`/api/v1/approvals/${encodeURIComponent(id)}/actions/reject`, {
    note: payload?.comment,
  })
  return mapHumanAction({ source_type: "approval", item: body })
}

export async function claimHumanAction(id: string): Promise<HumanAction> {
  // Clarifications use 'assign' to claim. Escalations use 'claim'.
  // We determine type by fetching the action first if needed, but in the UI we usually know it.
  const action = await getHumanAction(id)
  if (action.type === "clarification") {
    const body = await apiPost<unknown>(`/api/v1/clarifications/${encodeURIComponent(id)}/actions/assign`)
    return mapHumanAction({ source_type: "clarification", item: body })
  } else if (action.type === "escalation") {
    const body = await apiPost<unknown>(`/api/v1/escalations/${encodeURIComponent(id)}/actions/claim`, {})
    return mapHumanAction({ source_type: "escalation", item: body })
  }
  throw new Error("Cannot claim this type of action")
}

export async function resolveHumanAction(id: string, payload?: any): Promise<HumanAction> {
  const body = await apiPost<unknown>(`/api/v1/escalations/${encodeURIComponent(id)}/actions/resolve`, {
    note: payload?.comment,
  })
  return mapHumanAction({ source_type: "escalation", item: body })
}

export async function answerHumanAction(id: string, payload?: any): Promise<HumanAction> {
  const action = await getHumanAction(id)
  const runId = action.runId
  if (!runId) throw new Error("Cannot answer clarification: missing runId")
  const body = await apiPost<unknown>(
    `/api/v1/runs/${encodeURIComponent(runId)}/clarifications/${encodeURIComponent(id)}/answer`,
    { note: payload?.comment }
  )
  return mapHumanAction({ source_type: "clarification", item: body })
}

function mapHumanAction(wrapper: unknown): HumanAction {
  const record = wrapper as AnyRecord
  const type = String(record.source_type ?? "approval") as HumanActionType
  const item = record.item as AnyRecord ?? record // Fallback if directly passing item

  const requestedAction = item.requested_action as AnyRecord | undefined
  const title = String(item.title ?? requestedAction?.title ?? (type === "approval" ? "Pending Approval" : type === "clarification" ? "Clarification Required" : "Escalation"))
  
  return {
    id: asString(item.id),
    type,
    status: mapHumanActionStatus(item.status, type),
    priority: String(item.priority ?? "normal") as HumanActionPriority,
    title,
    description: item.description ?? requestedAction?.description ?? item.decision_note ?? item.note,
    workspaceId: asString(item.workspace_id ?? item.tenant_id ?? ""),
    runId: asString(item.run_id ?? ""),
    workflowId: item.workflow_id,
    workflowName: item.workflow_name ?? "Unknown Workflow",
    projectId: item.project_id,
    projectName: item.project_name,
    nodeId: item.node_execution_id,
    nodeName: item.node_name ?? "Node",
    ...(type === "approval" ? {
      approvalNodeKey: item.node_key ?? undefined,
      approvalMode: item.mode === "auto" ? "auto" : "ask",
      approvalStatus: item.status,
      policySetBy: item.policy_set_by ?? undefined,
    } : {}),
    createdAt: asDate(item.requested_at ?? item.created_at ?? item.createdAt),
    dueAt: item.expiry_at ? asDate(item.expiry_at) : undefined,
    claimedBy: item.assigned_to ? { id: item.assigned_to, name: "Assigned User" } : undefined,
    claimedAt: item.assigned_at ? asDate(item.assigned_at) : undefined,
    resolvedBy: item.decided_by ? { id: item.decided_by, name: "Approver" } : undefined,
    resolvedAt: item.decided_at ? asDate(item.decided_at) : undefined,
  }
}

function mapHumanActionStatus(value: unknown, type: HumanActionType): HumanActionStatus {
  if (type === "approval") {
    if (value === "pending") return "open"
    if (value === "approved" || value === "rejected") return "resolved"
    if (value === "expired" || value === "skipped") return "expired"
    throw new Error("Unsupported approval status")
  }
  if (value === "pending" || value === "open") return "open"
  if (value === "claimed" || value === "assigned") return "claimed"
  if (value === "approved" || value === "rejected" || value === "answered" || value === "resolved") return "resolved"
  if (value === "expired" || value === "cancelled") return "expired"
  return "open"
}

// --- Repository Manager (task 5.2) -----------------------------------------

function mapRepositoryBinding(value: unknown): RepositoryBinding {
  const item = value as AnyRecord
  return {
    id: asString(item.id),
    connectionId: asString(item.connection_id),
    fullName: asString(item.full_name),
    defaultBranch: asString(item.default_branch),
    private: item.private === true,
    htmlUrl: asString(item.html_url),
    createdAt: asString(item.created_at),
  }
}

export async function getRepositories(): Promise<RepositoryBinding[]> {
  const body = await apiGet<unknown>("/api/v1/repositories")
  return (Array.isArray(body) ? body : []).map(mapRepositoryBinding)
}

export async function getAvailableRepositories(connectionId: string): Promise<AvailableRepository[]> {
  const body = await apiGet<unknown>(
    `/api/v1/repositories/available?connection_id=${encodeURIComponent(connectionId)}`,
  )
  return (Array.isArray(body) ? body : []).map((value) => {
    const item = value as AnyRecord
    return {
      fullName: asString(item.full_name),
      defaultBranch: asString(item.default_branch),
      private: item.private === true,
      htmlUrl: asString(item.html_url),
    }
  })
}

export async function bindRepository(connectionId: string, fullName: string): Promise<RepositoryBinding> {
  return mapRepositoryBinding(
    await apiPost<unknown>(
      "/api/v1/repositories",
      { connection_id: connectionId, full_name: fullName },
      { idempotencyKey: mutationKey("repository-bind") },
    ),
  )
}

export async function unbindRepository(id: string): Promise<void> {
  await apiDelete(`/api/v1/repositories/${encodeURIComponent(id)}`)
}

export async function getRepositoryBranches(id: string): Promise<RepositoryBranch[]> {
  const body = await apiGet<unknown>(`/api/v1/repositories/${encodeURIComponent(id)}/branches`)
  return (Array.isArray(body) ? body : []).map((value) => {
    const item = value as AnyRecord
    return { name: asString(item.name), commitSha: asString(item.commit_sha), protected: item.protected === true }
  })
}

export async function getRepositoryPullRequests(id: string): Promise<RepositoryPullRequest[]> {
  const body = await apiGet<unknown>(`/api/v1/repositories/${encodeURIComponent(id)}/pulls`)
  return (Array.isArray(body) ? body : []).map((value) => {
    const item = value as AnyRecord
    return {
      number: Number(item.number),
      title: asString(item.title),
      draft: item.draft === true,
      author: typeof item.author === "string" ? item.author : null,
      headBranch: asString(item.head_branch),
      baseBranch: asString(item.base_branch),
      htmlUrl: asString(item.html_url),
      updatedAt: asString(item.updated_at),
    }
  })
}

export async function getConversations(filters?: { type?: string }) {
  const query = filters?.type ? `?type=${encodeURIComponent(filters.type)}` : ""
  const chats = await apiGet<unknown[]>(`/api/v1/conversations${query}`)
  return chats.map(chat => WorkflowChatResourceSchema.parse(chat))
}

export async function getConversation(id: string) {
  return WorkflowChatResourceSchema.parse(await apiGet(`/api/v1/conversations/${encodeURIComponent(id)}`))
}

export async function createConversation(input: unknown) {
  const body = CreateWorkflowChatRequestSchema.parse(input)
  const path = body.type === "workflow_builder" ? "/api/v1/conversations/workflows" : "/api/v1/conversations"
  return WorkflowChatResourceSchema.parse(await apiPost(path, body, { idempotencyKey: mutationKey("create-chat") }))
}

export async function getConversationMessages(id: string) {
  const messages = await apiGet<unknown[]>(`/api/v1/conversations/${encodeURIComponent(id)}/messages`)
  return messages.map(message => WorkflowChatMessageSchema.parse(message))
}

export async function sendMessage(id: string, input: unknown) {
  const body = SendWorkflowChatMessageSchema.parse(input)
  const chat = await getConversation(id)
  const path = `/api/v1/conversations/${encodeURIComponent(id)}/${chat.type === "workflow_builder" ? "build" : "messages"}`
  return WorkflowChatExchangeSchema.parse(await apiPost(path, body, { idempotencyKey: mutationKey("chat-message") }))
}

export async function archiveConversation(id: string) {
  const chat = await getConversation(id)
  const path = `/api/v1/conversations/${encodeURIComponent(id)}/${chat.type === "workflow_builder" ? "workflow-archive" : "archive"}`
  await apiPost(path, {}, { idempotencyKey: mutationKey("archive-chat") })
}

export async function createConversationDraft(id: string) {
  return WorkflowChatResourceSchema.parse(await apiPost(`/api/v1/conversations/${encodeURIComponent(id)}/drafts`, {}, { idempotencyKey: mutationKey("chat-draft") }))
}
