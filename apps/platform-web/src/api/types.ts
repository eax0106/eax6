import type { WorkflowChatMessage, WorkflowChatResource } from "@alterx/contracts"
import type { CompiledDag } from "@alterx/contracts"

export type WorkflowStatus = "draft" | "active" | "paused" | "archived"
export type DisplayCurrency = "USD" | "INR"
export type RunStatus = "queued" | "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "degraded"

export interface Workspace {
  id: string
  name: string
  slug: string
  avatarUrl?: string
  role: WorkspaceRole
  tenantOwner?: boolean
  memberCount: number
  createdAt: string
}

/** D2: a deleted workspace waiting out its restore window. */
export interface PendingDeletionWorkspace {
  id: string
  name: string
  deletionDueAt: string
}

/** D2: how long the workspace keeps finished runs (7 to 365 days). */
export interface RunRetention {
  retentionDays: number
  isDefault: boolean
  updatedAt: string | null
  etag: string
}

export type TenantRole = "owner" | "admin" | "billing" | "member"

export interface TenantDataResidency {
  allowed: string[]
  legalBasis?: string
}

export interface TenantDataResidencySettings {
  tenantId: string
  tenantName: string
  role: TenantRole
  dataResidency: TenantDataResidency | null
  etag?: string
}

export interface User {
  id: string
  name: string
  email: string
  avatarUrl?: string
}

export interface Workflow {
  folderId?: string | null
  folderEtag?: string
  id: string
  name: string
  description?: string
  status: WorkflowStatus
  runs: number
  successRate: number
  updatedAt: string
  dag?: CompiledDag
}

export interface Run {
  id: string
  
  workflowId?: string
  workflowName?: string
  
  projectId?: string
  projectName?: string
  
  mode: "workflow" | "project"
  
  status: RunStatus
  
  startedAt?: string
  completedAt?: string
  durationMs?: number
  
  triggeredBy?: {
    id: string
    name: string
  }
  
  trigger?: {
    type: string
    name: string
  }
  
  nodeCount?: number
  currentNodeId?: string
  
  createdAt: string
}

export interface ApiError {
  code: string
  message: string
  requestId?: string
  details?: unknown
}

export interface DashboardSummary {
  activeWorkflows: number
  runsToday: number
  successRate: number
  needsAttention: number
  recentWorkflows: Workflow[]
  recentRuns: Run[]
}

export const WORKSPACE_ROLES = ["admin", "editor", "operator", "approver", "viewer"] as const
export type WorkspaceRole = typeof WORKSPACE_ROLES[number]
/** Tenant owner is a badge and permission source, never an assignable workspace role. */
export type UserRole = WorkspaceRole | "owner"

export type MemberStatus = "active" | "invited" | "suspended"

export interface Member {
  id: string
  name: string
  email: string
  role: WorkspaceRole
  status: MemberStatus
  joinedAt: string
  workspaceId?: string
  userId?: string
  tenantOwner?: boolean
  etag?: string
  avatarUrl?: string
}

export interface WorkspaceInvitation {
  id: string
  workspaceId: string
  email: string
  role: WorkspaceRole
  status: "delivering" | "pending" | "delivery_failed" | "accepted" | "revoked" | "expired"
  expiresAt: string
  createdAt: string
  updatedAt: string
  etag: string
}

export type Permission =
  | "workspace.manage"
  | "member.read"
  | "member.invite"
  | "member.update"
  | "member.remove"
  | "role.read"
  | "role.manage"
  | "workflow.read"
  | "workflow.create"
  | "workflow.update"
  | "workflow.delete"
  | "workflow.run"
  | "project.read"
  | "project.create"
  | "project.update"
  | "project.run"
  | "run.read"
  | "human_action.read"
  | "human_action.claim"
  | "human_action.decide"
  | "human_action.annotate"
  | "knowledge.read"
  | "knowledge.manage"
  | "connection.read"
  | "connection.manage"
  | "billing.read"
  | "billing.manage"
  | "admin.access"
  | "conversation.read"
  | "conversation.create"
  | "trigger.read"
  | "trigger.manage"
  | "event.read"
  | "event.replay"
  | "webhook.read"
  | "webhook.manage"
  | "knowledge.test_retrieval"
  | "knowledge.memory_manage"
  | "connection.read"
  | "connection.manage"
  | "credential.read"
  | "credential.manage"
  | "channel.read"
  | "channel.manage"
  | "data.export"
  | "data.delete"
  | "seller.access"
  | "benchmark.read"
  | "benchmark.create"
  | "notification.read"
  | "notification.manage"
  | "admin.tenant.read"
  | "admin.tenant.manage"
  | "admin.user.read"
  | "admin.user.manage"
  | "audit.read"
  | "admin.audit.read"
  | "admin.provider.read"
  | "admin.provider.manage"
  | "admin.incident.read"
  | "admin.incident.manage"
  | "admin.policy.read"
  | "admin.policy.manage"
  | "admin.security.read"
  | "admin.security.manage"
  | "admin.billing.read"
  | "admin.billing.manage"
  | "admin.marketplace.read"
  | "admin.marketplace.manage"
  | "admin.feature_flags.read"
  | "admin.feature_flags.manage"
  | "support.access"
  | "support.impersonate"

export interface Profile {
  id: string
  name: string
  email: string
  jobTitle?: string
  avatarUrl?: string
}

export interface Session {
  id: string
  device: string
  browser: string
  location: string
  ip: string
  lastActive: string
  isCurrent: boolean
}

// Phase 3 Types

export interface WorkflowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, any>
  width?: number
  height?: number
  selected?: boolean
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  animated?: boolean
  label?: string
}

/**
 * A compiled version of a workflow, as the Deployment Manager reads it.
 * The statuses are the lifecycle service's own, and `trafficPercent` is set
 * only while a version is serving as the canary.
 */
export interface WorkflowVersion {
  id: string
  version: number
  status: "compiled" | "tested" | "canary" | "promoted" | "rolled_back" | "retired"
  dagSchemaVersion: string
  trafficPercent: number | null
  evaluationRunId: string | null
  testedAt: string | null
  evaluationFailedAt: string | null
  createdAt: string
}

export interface NodePortDefinition {
  id: string
  name: string
  type: string
}

export interface NodeTypeDefinition {
  type: string
  name: string
  description: string
  category: string
  icon?: string
  inputs: NodePortDefinition[]
  outputs: NodePortDefinition[]
  configSchema?: any
}

export type MessageRole = "user" | "assistant" | "system"
export type MessageType = "text" | "clarification" | "connections_required" | "workflow_draft" | "project_brief" | "project_plan" | "workflow_plan"

export interface ChatMessage {
  id: string
  role: MessageRole
  type: MessageType
  content: string
  data?: any
  createdAt: string
}

// "active" is what the projects table itself stores (draft/active/archived,
// 0019_create_projects.sql); the richer words below come from the planning
// resource rather than from the row.
export type ProjectStatus = "draft" | "active" | "clarifying" | "planning" | "ready" | "building" | "testing" | "completed" | "archived"

export interface ProjectBrief {
  goal: string
  primaryUsers: string
  coreCapabilities: string[]
}

/** A question the planner raised against a project's plan, answered in free text. */
export interface ProjectClarification {
  id: string
  question: string
  required: boolean
}

export interface ProjectPlanTask {
  id: string
  title: string
  description?: string
  status: "pending" | "in_progress" | "done"
  dependencies?: string[]
}

export interface ProjectPlanPhase {
  id: string
  title: string
  description?: string
  tasks: ProjectPlanTask[]
}

export interface ProjectPlan {
  phases: ProjectPlanPhase[]
}

export interface Project {
  id: string
  name: string
  status: ProjectStatus
  brief?: ProjectBrief
  plan?: ProjectPlan
  createdAt: string
  updatedAt: string
}

// Phase 4 Types

export type NodeExecutionStatus = "pending" | "queued" | "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled"

export interface DataReference {
  id: string
  kind: "json" | "text" | "file" | "artifact" | "binary"
  label?: string
  preview?: unknown
  sizeBytes?: number
}

export interface RunError {
  code: string
  message: string
  details?: any
}

export interface RunNodeExecution {
  id: string
  runId: string
  nodeId: string
  nodeName: string
  nodeType: string
  status: NodeExecutionStatus
  attempt: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
  inputRefs?: DataReference[]
  outputRefs?: DataReference[]
  error?: RunError
  metadata?: Record<string, unknown>
}

export interface RunEventBase {
  id: string
  runId: string
  sequence: number
  timestamp: string
}

export interface RunStatusEvent extends RunEventBase {
  type: "run.status" | "run.started" | "run.completed" | "run.failed"
  status: RunStatus
}

export interface NodeStatusEvent extends RunEventBase {
  type: "node.started" | "node.completed" | "node.failed" | "node.waiting" | "node.retrying"
  nodeId: string
  status: NodeExecutionStatus
  attempt: number
}

export interface ModelDeltaEvent extends RunEventBase {
  type: "model.delta"
  nodeId: string
  delta: string
}

export interface TerminalEvent extends RunEventBase {
  type: "terminal.stdout" | "terminal.stderr"
  content: string
}

export interface ArtifactCreatedEvent extends RunEventBase {
  type: "artifact.created"
  artifactId: string
}

export interface ProjectFileEvent extends RunEventBase {
  type: "project.file.changed"
  fileId: string
  status: "created" | "modified" | "deleted"
}

export interface TestEvent extends RunEventBase {
  type: "test.started" | "test.completed"
  testId?: string
}

export interface HumanActionEvent extends RunEventBase {
  type: "human_action.created" | "human_action.resolved"
  actionId: string
}

export type RunEvent = 
  | RunStatusEvent 
  | NodeStatusEvent 
  | ModelDeltaEvent 
  | TerminalEvent 
  | ArtifactCreatedEvent 
  | ProjectFileEvent 
  | TestEvent
  | HumanActionEvent

export interface Artifact {
  id: string
  runId: string
  nodeId?: string
  name: string
  type: "file" | "report" | "image" | "json" | "archive" | "code" | "other"
  mimeType?: string
  sizeBytes?: number
  createdAt: string
  previewUrl?: string
  downloadUrl?: string
  metadata?: Record<string, unknown>
}

export interface ProjectFile {
  id: string
  path: string
  name: string
  type: "file" | "directory"
  language?: string
  status?: "unchanged" | "created" | "modified" | "deleted"
  content?: string
}

export interface TestResult {
  id: string
  name: string
  suite?: string
  status: "passed" | "failed" | "skipped"
  durationMs?: number
  error?: string
}

// Phase 5 Types

export type HumanActionType = "approval" | "clarification" | "escalation"
// Engine approval API vocabulary. UI tabs use HumanActionTab below.
export const approvalStatuses = ["pending", "approved", "rejected", "expired", "skipped"] as const
export type ApprovalStatus = typeof approvalStatuses[number]
// Approval API status is separate from UI action lifecycle status.
export type HumanActionStatus = "open" | "claimed" | "resolved" | "expired" | "cancelled"
export type HumanActionTab = "open" | "claimed" | "resolved" | "all"
export interface HumanActionFilters { status?: HumanActionTab; type?: HumanActionType }
export type HumanActionResolution = "approved" | "rejected" | "answered" | "resolved" | "dismissed"
export type HumanActionPriority = "low" | "normal" | "high" | "critical"

/** What a workflow's plans run with, from the workspace and the workflow. */
export interface WorkflowSafeguards {
  /** The workspace's rules. A workflow can add to these, never switch them off. */
  workspace: { containsPii: boolean; approveExternalActions: boolean }
  additions: { customerVisible: boolean; containsPii: boolean; approveExternalActions: boolean }
  /** What every plan of this workflow runs with: the workspace's rules or the workflow's. */
  effective: { customerVisible: boolean; containsPii: boolean; approveExternalActions: boolean }
  /** Sent back on save, so a change made since this read is refused. */
  etag?: string
}

export interface HumanActionOption {
  id: string
  label: string
  value?: string
}

export interface HumanActionContext {
  summary?: string
  reason?: string
  inputRefs?: DataReference[]
  outputRefs?: DataReference[]
  recommendation?: string
  confidence?: number
  risk?: string
  options?: HumanActionOption[]
}

export interface UserSummary {
  id: string
  name: string
  avatarUrl?: string
}

export interface HumanAction {
  id: string
  type: HumanActionType
  status: HumanActionStatus
  priority: HumanActionPriority
  title: string
  description?: string
  workspaceId: string
  runId: string
  workflowId?: string
  workflowName?: string
  projectId?: string
  projectName?: string
  nodeId?: string
  nodeName?: string
  approvalNodeKey?: string
  approvalMode?: "ask" | "auto"
  approvalStatus?: ApprovalStatus
  policySetBy?: string
  createdAt: string
  dueAt?: string
  claimedBy?: UserSummary
  claimedAt?: string
  resolvedBy?: UserSummary
  resolvedAt?: string
  resolution?: HumanActionResolution
  context?: HumanActionContext
  metadata?: Record<string, unknown>
}

export interface HumanAnnotation {
  id: string
  actionId: string
  author: UserSummary
  text: string
  createdAt: string
}

export interface RecoveryEvent {
  id: string
  runId: string
  nodeId?: string
  type: "retry" | "skip" | "rollback" | "human_decision" | "manual_resume" | "abort"
  actor: UserSummary | { type: "system"; name: "AlterX" }
  summary: string
  createdAt: string
  metadata?: Record<string, unknown>
}

export type VerificationStatus = "not_run" | "running" | "passed" | "warning" | "failed"

export interface VerificationCheck {
  id: string
  name: string
  status: "passed" | "warning" | "failed"
  message?: string
  evidenceRefs?: DataReference[]
}

export interface NodeVerification {
  status: VerificationStatus
  summary?: string
  checks: VerificationCheck[]
}

export interface HealthDimension {
  score: number | null
  status: "healthy" | "warning" | "critical" | "not_enough_data"
  summary: string
  observations?: number
  passed?: number
  issues?: { id: string; message: string }[]
}

export interface WorkflowHealth {
  workflowId: string
  overallScore: number | null
  status: HealthDimension["status"]
  dimensions: {
    validation: HealthDimension
    availability: HealthDimension
    correctness: HealthDimension
    reliability: HealthDimension
  }
  recentFailures: number
  degradedRuns: number
  lastEvaluatedAt: string
  window?: { startAt: string; endAt: string; maximumRuns: 20; sampledRuns: number }
}

export type WorkflowHealthCollection = Pick<import("@alterx/contracts").WorkflowHealthPage, "page"> & {
  data: WorkflowHealth[]
}

// Phase 6 Types

export type ConversationType = WorkflowChatResource["type"]
export type ConversationStatus = WorkflowChatResource["status"]
export type Conversation = WorkflowChatResource & { linkedProjectId?: string; linkedRunId?: string }
export type ConversationMessageRole = WorkflowChatMessage["role"]
export type ConversationMessageKind = WorkflowChatMessage["kind"]
export type ConversationMessage = WorkflowChatMessage

export type TriggerType = "manual" | "webhook" | "schedule" | "event" | "email"
export type TriggerStatus = "configured" | "needs_configuration" | "error"

export interface Trigger {
  id: string
  workflowId: string
  type: TriggerType
  name: string
  enabled: boolean
  status: TriggerStatus
  config: Record<string, unknown>
  lastTriggeredAt?: string
  lastTestedAt?: string
  createdAt: string
  updatedAt: string
}

export type WebhookAuthentication = "none" | "secret" | "signature"

export interface WebhookEndpoint {
  id: string
  name: string
  workflowId: string
  triggerId: string
  path: string
  url: string
  method: string
  enabled: boolean
  authentication: WebhookAuthentication
  createdAt: string
  lastReceivedAt?: string
}

export type EventSource = "webhook" | "schedule" | "email" | "integration" | "internal"
export type EventStatus = "received" | "matched" | "triggered" | "ignored" | "failed"

export interface IncomingEvent {
  id: string
  source: EventSource
  type: string
  status: EventStatus
  workflowId?: string
  triggerId?: string
  runId?: string
  receivedAt: string
  payloadRef?: DataReference
  payload?: Record<string, unknown>
  error?: ApiError
}

export interface EventReplayPreview {
  mode: "dry_run"
  eventId: string
  workflowId: string
  workflowVersionId: string
  payload: Record<string, unknown>
  trace: { key: string; type: string; status: "simulated"; input: Record<string, unknown> }[]
  actions: { nodeKey: string; toolName: string }[]
  confirmationToken: string
}

export interface DashboardOverview {
  metrics: { activeWorkflows: number; runsToday: number; successRate: number; needsAttention: number }
  liveRuns: Run[]
  humanActions: { total: number; approvals: number; clarifications: number; escalations: number }
  health: { healthy: number; warning: number; critical: number }
  triggerSummary: { enabled: number; needsConfiguration: number; failing: number }
  recentEvents: IncomingEvent[]
  projectBuilds: Run[]
}

// Phase 7 Types

export type KnowledgeSourceType = "file_upload" | "website" | "notion" | "google_drive" | "confluence" | "database" | "api"
export type KnowledgeSourceStatus = "ready" | "syncing" | "processing" | "failed" | "paused"

export interface KnowledgeSource {
  id: string
  name: string
  type: KnowledgeSourceType
  status: KnowledgeSourceStatus
  documentCount: number
  chunkCount: number
  lastSyncedAt?: string
  nextSyncAt?: string
  createdAt: string
  updatedAt: string
  connectionId?: string
  config?: Record<string, unknown>
}

export interface KnowledgeDocument {
  id: string
  sourceId: string
  name: string
  mimeType?: string
  sizeBytes?: number
  status: "queued" | "processing" | "indexed" | "failed" | "excluded"
  chunkCount?: number
  error?: ApiError
  createdAt: string
  indexedAt?: string
}

export interface KnowledgeChunk {
  id: string
  sourceId: string
  documentId: string
  index: number
  contentPreview: string
  tokenCount?: number
  metadata?: Record<string, unknown>
  embeddingStatus?: "indexed" | "failed"
}

export interface IngestionProgress {
  stage: "uploading" | "extracting" | "chunking" | "embedding" | "indexing" | "complete" | "failed"
  progress?: number
  message?: string
}

export interface ProvenanceReference {
  id: string
  sourceId: string
  sourceName: string
  documentId?: string
  documentName?: string
  chunkId?: string
  label?: string
  confidence?: number
  excerpt?: string
}

export interface RetrievalResult {
  id: string
  chunkId: string
  sourceId: string
  documentId: string
  content: string
  score: number
  confidence?: "high" | "medium" | "low"
  provenance: ProvenanceReference[]
}

export type MemoryConfiguration = import("@alterx/contracts").WorkspaceMemorySettings

export type IntegrationCategory = "Communication" | "Productivity" | "Development" | "Data" | "CRM" | "Storage" | "AI" | "Other"

export interface IntegrationDefinition {
  id: string
  name: string
  category: IntegrationCategory
  description: string
  icon?: string
  capabilities: string[]
  authType: "oauth" | "api_key" | "token" | "credentials" | "none"
  available: boolean
}

export interface Connection {
  id: string
  integrationId: string
  name: string
  status: "connected" | "degraded" | "disconnected" | "expired" | "error"
  createdAt: string
  updatedAt: string
  lastCheckedAt?: string
  credentialId?: string
  metadata?: Record<string, unknown>
}

export interface Credential {
  id: string
  name: string
  type: "api_key" | "oauth" | "token" | "username_password" | "secret"
  provider?: string
  maskedValue?: string
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  usedByConnectionIds: string[]
}

export interface WhatsAppChannel {
  id: string
  name: string
  phoneNumber: string
  status: "connected" | "pending" | "degraded" | "disconnected"
  provider: "meta" | "twilio" | "mock"
  connectionId?: string
  createdAt: string
}

export interface WhatsAppTemplate {
  name: string
  language: string
  status: string
}

export interface WhatsAppTestMessage {
  to: string
  templateName: string
  languageCode: string
}




// --- Phase 8: Money & Billing ---
export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  totalCost: number;
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  computeSeconds?: number;
  storageBytes?: number;
  workflowCount?: number;
  projectCount?: number;
}

export interface CostRecord {
  id: string;
  timestamp: string;
  amount: number;
  currency: string;
  category: "model" | "compute" | "storage" | "integration" | "other";
  provider?: string;
  model?: string;
  workflowId?: string;
  projectId?: string;
  runId?: string;
  nodeId?: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ModelUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  runCount: number;
}

/**
 * D3: a budget the engine enforces when a run starts. Amounts are rupees
 * (major units); the API keeps paise.
 */
export interface Budget {
  id: string;
  kind: "workspace" | "workflow" | "run_cap";
  workflowId: string | null;
  /** Null for a per-run cap, which caps each run rather than a period. */
  period: "daily" | "monthly" | null;
  amount: number;
  currency: "INR";
  /** hard: runs stop at the limit. warn: alerts only. */
  mode: "hard" | "warn";
  enabled: boolean;
  /** This period's spend; null for a per-run cap or when it could not be read. */
  currentSpend: number | null;
  /** Held for runs still going (their worst case); null for a per-run cap. */
  reserved: number | null;
  updatedAt: string;
}

export interface BudgetInput {
  kind: Budget["kind"];
  workflowId?: string;
  period?: "daily" | "monthly";
  amount: number;
  mode: Budget["mode"];
}

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  currency: string;
  interval: number;
  period: "daily" | "weekly" | "monthly" | "yearly";
  active: boolean;
}

export interface BillingSubscription {
  id: string;
  tenantId: string;
  planId: string;
  status: "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  providerCustomerRef: string | null;
  version: string;
}

export interface BillingPaymentMethod {
  ref: string;
  type: string;
  brand: string | null;
  last4: string | null;
}

export interface Invoice {
  id: string;
  subscriptionId: string | null;
  status: string;
  amount: number;
  currency: string;
  issuedAt: string;
  paidAt: string | null;
  /** The billing provider's hosted invoice page, where the PDF is downloaded. */
  documentUrl?: string | null;
}

export interface CostEstimateItem {
  name: string;
  amount: number;
}

export interface CostEstimate {
  currency: string;
  low: number;
  expected: number;
  high: number;
  breakdown: CostEstimateItem[];
  assumptions?: string[];
  confidence?: "low" | "medium" | "high";
}

// --- Phase 8: Marketplace & Seller ---
export type MarketplaceAssetType = "workflow_template" | "project_template" | "agent" | "tool" | "agent_pack" | "node_pack" | "knowledge_pack";

export interface SellerSummary {
  id: string;
  displayName: string;
  rating?: number;
}

export interface MarketplaceListing {
  id: string;
  slug: string;
  title: string;
  shortDescription: string;
  description: string;
  assetType: MarketplaceAssetType;
  category: string;
  seller: SellerSummary;
  pricing:
    | { type: "free" }
    /**
     * price is the major-unit amount the demo data uses, which the currency
     * switcher converts with a mock rate. A listing read from the API sets
     * priceMinor as well: that amount is already in its own currency and
     * must be shown as-is, never converted.
     */
    | { type: "paid"; price: number; currency: string; priceMinor?: string };
  rating?: number;
  reviewCount?: number;
  installCount?: number;
  tags: string[];
  status: "published" | "draft" | "private_testing" | "submitted" | "automated_review" | "human_review" | "suspended" | "deprecated" | "removed" | "review" | "rejected" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceAssetInstallation {
  id: string;
  listingId: string;
  workspaceId: string;
  installedAt: string;
  installedVersion?: string;
  createdWorkflowId?: string;
  createdProjectId?: string;
}


export interface MarketplaceReview {
  id: string;
  listingId: string;
  author: UserSummary;
  rating: number;
  title?: string;
  body?: string;
  createdAt: string;
}

export interface SellerProfile {
  id: string;
  displayName: string;
  status: "not_started" | "pending" | "verified" | "restricted";
  joinedAt: string;
  rating?: number;
  listingCount?: number;
}

export interface MarketplaceTransaction {
  id: string;
  listingId: string;
  amount: number;
  currency: string;
  sellerEarnings: number;
  createdAt: string;
  status: "completed" | "refunded" | "pending";
}

export interface MarketplacePayout {
  id: string;
  orderId: string;
  totalMinor: string;
  sellerShareMinor: string;
  platformShareMinor: string;
  status: "created" | "pending" | "processed" | "failed";
  createdAt: string;
}

export interface SellerEarnings {
  availableMinor: string;
  pendingMinor: string;
  paidMinor: string;
  currency: "INR";
}

export interface GlobalSearchResult {
  id: string;
  type: "workflow" | "project" | "run" | "conversation" | "knowledge_source" | "connection" | "marketplace_listing";
  title: string;
  description?: string;
  url: string;
  metadata?: Record<string, unknown>;
}

// --- Phase 9: Notifications, Discovery, Benchmarking ---

export type NotificationType =
  | 'run'
  | 'workflow'
  | 'project'
  | 'deployment'
  | 'human_action'
  | 'knowledge'
  | 'connection'
  | 'billing'
  | 'marketplace'
  | 'system';

export type NotificationStatus = 'unread' | 'read';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message?: string;
  status: NotificationStatus;
  priority?: 'normal' | 'high';
  createdAt: string;
  url?: string;
  entity?: {
    type: string;
    id: string;
  };
}

export interface NotificationPreference {
  category: NotificationType;
  inApp: boolean;
  email: boolean;
  importantOnly?: boolean;
}

export interface UseCase {
  id: string;
  title: string;
  description: string;
  category: string;
  audience?: string[];
  outcome?: string[];
  difficulty?: 'starter' | 'intermediate' | 'advanced';
  estimatedSetupMinutes?: number;
  workflowTemplateId?: string;
  projectTemplateId?: string;
  starterPrompt?: string;
}

export type BenchmarkMetricType =
  | 'accuracy'
  | 'success_rate'
  | 'latency'
  | 'cost'
  | 'verification_rate'
  | 'custom';

export interface BenchmarkMetricDefinition {
  id: string;
  name: string;
  type: BenchmarkMetricType;
  higherIsBetter: boolean;
}

export interface BenchmarkDataset {
  id: string;
  name: string;
  caseCount: number;
  description?: string;
}

export interface Benchmark {
  id: string;
  name: string;
  description?: string;
  targetType: 'workflow' | 'workflow_version' | 'project';
  targetId: string;
  datasetId?: string;
  metrics: BenchmarkMetricDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkMetricResult {
  metricId: string;
  value: number;
}

export interface BenchmarkResult {
  id: string;
  benchmarkId: string;
  targetId: string;
  version?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  metrics: BenchmarkMetricResult[];
  caseCount: number;
  passedCases: number;
  failedCases: number;
  startedAt?: string;
  completedAt?: string;
}

// --- Phase 10: Admin & Operations ---

export interface AdminTenant {
  id: string;
  name: string;
  // Live mode fills only what platform-api serves (task B1.1); the counts,
  // spend and slug are demo-mode data with no backend yet.
  slug?: string;
  status: "active" | "suspended" | "restricted" | "trial" | "closed";
  plan?: string;
  memberCount?: number;
  workflowCount?: number;
  runCount30d?: number;
  currentSpend?: number;
  createdAt: string;
  lastActiveAt?: string;
  region?: string;
  riskState?: "normal" | "review" | "restricted";
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended" | "invited" | "locked";
  tenantIds: string[];
  createdAt: string;
  lastActiveAt?: string;
  mfaEnabled?: boolean;
  riskState?: "normal" | "review" | "restricted";
}

export interface AdminNote {
  id: string;
  tenantId?: string;
  userId?: string;
  author: UserSummary;
  body: string;
  createdAt: string;
}

export interface SupportAccessRequest {
  id: string;
  tenantId: string;
  requestedBy: UserSummary;
  reason: string;
  status: "pending" | "approved" | "denied" | "active" | "expired" | "revoked";
  requestedAt: string;
  approvedAt?: string;
  expiresAt?: string;
  approvedBy?: UserSummary;
  scope?: string[];
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: {
    type: "user" | "admin" | "system" | "support";
    id?: string;
    name: string;
  };
  action: string;
  // "other": a live event whose action prefix names no known category (B1.3).
  category: "authentication" | "workspace" | "workflow" | "run" | "human_action" | "connection" | "knowledge" | "billing" | "marketplace" | "support" | "security" | "admin" | "other";
  tenantId?: string;
  target?: {
    type: string;
    id: string;
    label?: string;
  };
  outcome: "success" | "failure" | "denied";
  requestId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  type: "model" | "compute" | "storage" | "email" | "messaging" | "other";
  status: "healthy" | "degraded" | "outage" | "maintenance" | "disabled";
  enabled: boolean;
  lastCheckedAt?: string;
  latencyMs?: number;
  errorRate?: number;
  region?: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformDeployment {
  id: string;
  environment: "development" | "staging" | "production";
  version: string;
  status: "deploying" | "healthy" | "degraded" | "failed" | "rolled_back";
  startedAt?: string;
  completedAt?: string;
  deployedBy?: UserSummary;
  commit?: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: "sev1" | "sev2" | "sev3" | "sev4";
  // "draft": an incident not yet declared (live, B1.5).
  status: "draft" | "investigating" | "identified" | "monitoring" | "resolved";
  startedAt: string;
  resolvedAt?: string;
  commander?: UserSummary;
  affectedSystems: string[];
  summary?: string;
}

export interface PlatformPolicy {
  id: string;
  name: string;
  category: "execution" | "security" | "data" | "billing" | "marketplace";
  status: "active" | "draft" | "disabled";
  description: string;
  scope: "global" | "tenant";
  config: Record<string, unknown>;
  // Model alias bindings carry no change timestamp in live mode (B1.6).
  updatedAt?: string;
  updatedBy?: UserSummary;
}

export interface SecurityReviewItem {
  id: string;
  type: "suspicious_login" | "abuse" | "credential_issue" | "rate_anomaly" | "policy_violation";
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "investigating" | "resolved" | "dismissed";
  tenantId?: string;
  userId?: string;
  title: string;
  summary: string;
  createdAt: string;
}

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  scope: "global" | "tenant";
  tenantIds?: string[];
  updatedAt: string;
  updatedBy: UserSummary;
}

// Repository Manager (task 5.2): a workspace's links to GitHub repositories,
// read through one of its own GitHub connections. Branches and pull requests
// are live reads, never stored.
export interface RepositoryBinding {
  id: string
  connectionId: string
  fullName: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
  createdAt: string
}

export interface AvailableRepository {
  fullName: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

export interface RepositoryBranch {
  name: string
  commitSha: string
  protected: boolean
}

export interface RepositoryPullRequest {
  number: number
  title: string
  draft: boolean
  author: string | null
  headBranch: string
  baseBranch: string
  htmlUrl: string
  updatedAt: string
}

/** D4: what a run of a workflow costs the tenant, in paise, shown before it runs. */
export interface RunCostEstimate {
  /** The worst case; what a run reserves against its budgets. */
  atMostMinor: number
  /** The average of the last five verified runs; null until five exist. */
  usuallyMinor: number | null
  sampleRuns: number
  /** Model calls with no price on record: the worst case is too low by their share. */
  unpricedCalls: number
}

export interface ApprovalPolicyStep {
  nodeKey: string
  mode: "ask" | "auto"
  sideEffectConsequence: string | null
  autoConfirmedBy: string | null
  autoConfirmedAt: string | null
  skipOnTimeout: boolean
  timeoutSeconds: number | null
  consecutiveApprovals: number
  promotionSuggested: boolean
  setBy: string | null
  updatedAt: string | null
  etag: string
}
export interface ApprovalPolicies { policies: ApprovalPolicyStep[]; canEdit: boolean }
export interface ApprovalPolicyChange {
  mode: "ask" | "auto"
  skipOnTimeout: boolean
  timeoutSeconds: number | null
  confirmConsequence?: string
}
