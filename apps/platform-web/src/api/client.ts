import { HostedFormDefinitionSchema, type HostedFormDefinition, type HostedFormSetup } from "@alterx/contracts"

import { usageService, budgetsService, costEstimatesService } from "./services/usage"
import { runRetentionService } from "./services/run-retention"
import { billingService } from "./services/billing"
import { marketplaceService } from "./services/marketplace"
import { sellerService } from "./services/seller"
import { globalSearchService } from "./services/global-search"
import { notificationsService } from "./services/notifications"
import { discoveryService } from "./services/discovery"
import { benchmarksService } from "./services/benchmarks"
import { AdminTenantsService } from "./services/admin-tenants"
import { AdminUsersService } from "./services/admin-users"
import { AuditService } from "./services/audit"
import { ProvidersService } from "./services/providers"
import { DeploymentsService } from "./services/deployments"
import { IncidentsService } from "./services/incidents"
import { PoliciesService } from "./services/policies"
import { SecurityService } from "./services/security"
import { BillingOpsService } from "./services/billing-ops"
import { MarketplaceAdminService } from "./services/marketplace-admin"
import { FeatureFlagsService } from "./services/feature-flags"
import { SupportAccessService } from "./services/support-access"
import { isLiveApi } from "./http"
import { compileDag } from "./compile-dag"
import { CompiledDagSchema, withNodeOverrideSafeguards, NodeOverrideChoiceSchema, ConnectionsRequiredSchema, ConfirmWorkflowBuildSchema, WorkflowPlanSchema, type WorkflowPlan, type ConnectionsRequired, hasExternalSideEffect } from "@alterx/contracts"
import type {
  AvailableRepository,
  HumanActionFilters,
  RepositoryBinding,
  RepositoryBranch,
  RepositoryPullRequest,
} from "./types"
import * as approvalPoliciesLive from "./live-approval-policies"
import * as approvalPoliciesMock from "./mock/approval-policies"
import type { ApprovalPolicyChange } from "./types"
import * as workflowFolders from "./workflow-folders"
import * as nodeOverrides from "./node-overrides"
import * as live from "./live"
import * as workspaceMembers from "./members"
import * as liveDataExport from "./live-data-export"
import * as liveMemorySettings from "./live-memory-settings"
import { 
  mockWorkflows, mockRuns, mockDashboardSummary, 
  mockWorkspaces, mockProfile, mockSessions, delay,
  mockNodeTypes, mockProjects, mockArtifacts,
  mockHumanActions, mockHumanAnnotations, mockRecoveryEvents, mockWorkflowHealth,
  mockConversations, mockConversationMessages, mockTriggers, mockWebhooks, mockEvents, mockDashboardOverview,
  mockKnowledgeSources, mockKnowledgeDocuments, mockKnowledgeChunks, mockIntegrationDefinitions, mockConnections,
  mockCredentials, mockWhatsAppChannels, mockMemoryConfig
} from "./mock/data"
import { 
  type Workflow, type WorkflowSafeguards, type WorkflowVersion, type RunCostEstimate, type Run, type DashboardSummary, 
  type Workspace, type PendingDeletionWorkspace, type TenantDataResidency,
  type TenantDataResidencySettings,
  type Profile, type Session,
  type Project, type ProjectBrief, type ProjectClarification, type NodeTypeDefinition,
  type Artifact, type ProjectFile, type TestResult,
  type HumanAction, type HumanActionType, type HumanAnnotation, type RecoveryEvent, type WorkflowHealth, type WorkflowHealthCollection, type NodeVerification,
  type Conversation, type ConversationMessage, type Trigger, type WebhookEndpoint, type IncomingEvent, type DashboardOverview,
  type KnowledgeSource, type KnowledgeDocument, type IntegrationDefinition, type Connection,
  type Credential, type WhatsAppChannel, type WhatsAppTemplate, type WhatsAppTestMessage, type MemoryConfiguration, type RetrievalResult
} from "./types"

const MOCK_DELAY = 600
const mockPendingDeletion: { workspace: Workspace; deletionDueAt: string }[] = []

class ApiClient {
  private readonly hostedForms = new Map<string, HostedFormSetup>()
  getNodeOverrideOptions = nodeOverrides.getNodeOverrideOptions
  compareNodeOverride = nodeOverrides.compareNodeOverride
  getWorkflowFolders = workflowFolders.getWorkflowFolders
  createWorkflowFolder = workflowFolders.createWorkflowFolder
  renameWorkflowFolder = workflowFolders.renameWorkflowFolder
  deleteWorkflowFolder = workflowFolders.deleteWorkflowFolder
  moveWorkflowFolder = workflowFolders.moveWorkflowFolder
  async getDashboardSummary(): Promise<DashboardSummary> {
    if (isLiveApi) return live.getDashboardSummary(mockDashboardSummary)
    await delay(MOCK_DELAY)
    if (typeof window !== "undefined" && window.location.search.includes("mockError=dashboard")) {
      throw new Error("Failed to load dashboard summary")
    }
    return mockDashboardSummary
  }

  async getWorkflows(): Promise<Workflow[]> {
    if (isLiveApi) return live.getWorkflows()
    await delay(MOCK_DELAY)
    return mockWorkflows
  }

  async getRuns(): Promise<Run[]> {
    if (isLiveApi) return live.getRuns()
    await delay(MOCK_DELAY)
    return mockRuns
  }

  async getRun(id: string): Promise<Run> {
    if (isLiveApi) return live.getRun(id)
    await delay(MOCK_DELAY)
    const run = mockRuns.find(r => r.id === id)
    if (!run) throw new Error("Run not found")
    return run
  }

  async stopRun(_id: string): Promise<void> {
    if (isLiveApi) return live.stopRun(_id)
    await delay(MOCK_DELAY)
  }

  async retryRun(_id: string, _nodeKey: string): Promise<Run> {
    if (isLiveApi) return live.retryRun(_id, _nodeKey)
    await delay(MOCK_DELAY)
    return {
      ...mockRuns[0],
      id: `run_${Date.now()}`,
      status: "running",
      startedAt: new Date().toISOString(),
      durationMs: undefined,
      completedAt: undefined
    }
  }

  async getArtifacts(): Promise<Artifact[]> {
    if (isLiveApi) return live.getArtifacts()
    await delay(MOCK_DELAY)
    return mockArtifacts
  }

  async getRunArtifacts(runId: string): Promise<Artifact[]> {
    if (isLiveApi) return live.getArtifactsByRun(runId)
    await delay(MOCK_DELAY)
    return mockArtifacts.filter(a => a.runId === runId)
  }

  async getArtifact(id: string): Promise<Artifact> {
    if (isLiveApi) return live.getArtifact(id)
    await delay(MOCK_DELAY)
    const art = mockArtifacts.find(a => a.id === id)
    if (!art) throw new Error("Artifact not found")
    return art
  }

  // Workspaces
  async getWorkspaces(): Promise<Workspace[]> {
    if (isLiveApi) return live.getWorkspaces()
    await delay(MOCK_DELAY)
    return mockWorkspaces
  }

  async getTenantDataResidencySettings(): Promise<TenantDataResidencySettings> {
    if (isLiveApi) return live.getTenantDataResidencySettings()
    await delay(MOCK_DELAY)
    return mockTenantDataResidencySettings
  }

  async updateTenantDataResidencySettings(
    tenantId: string,
    dataResidency: TenantDataResidency | null,
    etag: string | undefined,
  ): Promise<TenantDataResidencySettings> {
    if (isLiveApi) {
      return live.updateTenantDataResidencySettings(tenantId, dataResidency, etag)
    }
    await delay(MOCK_DELAY)
    mockTenantDataResidencySettings = {
      ...mockTenantDataResidencySettings,
      tenantId,
      dataResidency,
      etag: `"mock-${Date.now()}"`,
    }
    return mockTenantDataResidencySettings
  }

  async createWorkspace(data: { name: string; slug: string }): Promise<Workspace> {
    if (isLiveApi) return live.createWorkspace(data)
    await delay(MOCK_DELAY)
    return {
      id: `ws_${Date.now()}`,
      name: data.name,
      slug: data.slug,
      role: "admin",
      tenantOwner: true,
      memberCount: 1,
      createdAt: new Date().toISOString()
    }
  }

  async updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace> {
    if (isLiveApi) return live.updateWorkspace(id, data)
    await delay(MOCK_DELAY)
    const ws = mockWorkspaces.find(w => w.id === id)
    if (!ws) throw new Error("Workspace not found")
    return { ...ws, ...data }
  }

  async deleteWorkspace(id: string, confirmName: string): Promise<{ deletionDueAt: string }> {
    if (isLiveApi) return live.deleteWorkspace(id, confirmName)
    await delay(MOCK_DELAY)
    const idx = mockWorkspaces.findIndex(w => w.id === id)
    if (idx === -1) throw new Error("Workspace not found")
    if (mockWorkspaces[idx]!.name !== confirmName) throw new Error("Workspace name does not match")
    const [removed] = mockWorkspaces.splice(idx, 1)
    const deletionDueAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
    mockPendingDeletion.push({ workspace: removed!, deletionDueAt })
    return { deletionDueAt }
  }

  async getPendingDeletionWorkspaces(): Promise<PendingDeletionWorkspace[]> {
    if (isLiveApi) return live.getPendingDeletionWorkspaces()
    await delay(MOCK_DELAY)
    return mockPendingDeletion.map(({ workspace, deletionDueAt }) => ({
      id: workspace.id,
      name: workspace.name,
      deletionDueAt,
    }))
  }

  async restoreWorkspace(id: string): Promise<void> {
    if (isLiveApi) return live.restoreWorkspace(id)
    await delay(MOCK_DELAY)
    const idx = mockPendingDeletion.findIndex(p => p.workspace.id === id)
    if (idx === -1) throw new Error("Workspace not found")
    const [restored] = mockPendingDeletion.splice(idx, 1)
    mockWorkspaces.push(restored!.workspace)
  }

  // Members and invitations share the same scoped live/mock lifecycle.
  getMembers = workspaceMembers.getMembers
  getInvitations = workspaceMembers.getInvitations
  inviteMember = workspaceMembers.inviteMember
  updateMemberRole = workspaceMembers.updateMemberRole
  removeMember = workspaceMembers.removeMember
  resendInvite = workspaceMembers.resendInvite
  revokeInvite = workspaceMembers.revokeInvite

  // Settings: Profile
  async getProfile(): Promise<Profile> {
    if (isLiveApi) return live.getProfile(mockProfile)
    await delay(MOCK_DELAY)
    return mockProfile
  }

  async updateProfile(data: Partial<Profile>): Promise<Profile> {
    if (isLiveApi) return live.updateProfile(data, mockProfile)
    await delay(MOCK_DELAY)
    return { ...mockProfile, ...data }
  }

  // Settings: Security
  requestPasswordReset = workspaceMembers.requestPasswordReset

  // Settings: Sessions
  async getSessions(): Promise<Session[]> {
    if (isLiveApi) return live.getSessions()
    await delay(MOCK_DELAY)
    return mockSessions
  }

  async revokeSession(_sessionId: string): Promise<void> {
    if (isLiveApi) return live.revokeSession(_sessionId)
    await delay(MOCK_DELAY)
  }

  async revokeOtherSessions(): Promise<void> {
    if (isLiveApi) return live.revokeOtherSessions()
    await delay(MOCK_DELAY)
  }

  // Settings: Language. Live mode reads the saved preference from the
  // backend (GET /api/v1/i18n/users/me/language) and keeps localStorage as a
  // cache, so a second device starts in the language the user chose.
  async getLanguage(): Promise<string> {
    if (isLiveApi) {
      const lang = await live.getLanguage()
      localStorage.setItem("alterx_lang", lang)
      return lang
    }
    await delay(MOCK_DELAY)
    return localStorage.getItem("alterx_lang") || "en-US"
  }

  async updateLanguage(lang: string): Promise<void> {
    if (isLiveApi) await live.updateLanguage(lang)
    else await delay(MOCK_DELAY)
    localStorage.setItem("alterx_lang", lang)
  }
  // Node Types
  async getNodeTypes(): Promise<NodeTypeDefinition[]> {
    if (isLiveApi) return live.getNodeTypes()
    await delay(MOCK_DELAY)
    return mockNodeTypes
  }

  // Workflows (Builder phase)
  async getWorkflow(id: string): Promise<Workflow> {
    if (isLiveApi) return live.getWorkflow(id)
    await delay(MOCK_DELAY)
    const wf = mockWorkflows.find(w => w.id === id)
    if (!wf) throw new Error("Workflow not found")
    return wf
  }

  async getRunEstimate(id: string): Promise<RunCostEstimate> {
    if (isLiveApi) return live.getRunEstimate(id)
    await delay(MOCK_DELAY)
    return { atMostMinor: 1250, usuallyMinor: null, sampleRuns: 0, unpricedCalls: 0 }
  }

  async getApprovalPolicies(workflowId: string) {
    return isLiveApi ? approvalPoliciesLive.getApprovalPolicies(workflowId) : approvalPoliciesMock.getMockApprovalPolicies(workflowId)
  }
  async setApprovalPolicy(workflowId: string, nodeKey: string, change: ApprovalPolicyChange, etag: string) {
    return isLiveApi ? approvalPoliciesLive.setApprovalPolicy(workflowId, nodeKey, change, etag) : approvalPoliciesMock.setMockApprovalPolicy(workflowId, nodeKey, change, etag)
  }

  async getWorkflowSafeguards(id: string): Promise<WorkflowSafeguards> {
    if (isLiveApi) return live.getWorkflowSafeguards(id)
    await delay(MOCK_DELAY)
    return mockSafeguards(id)
  }

  async updateWorkflowSafeguards(
    id: string,
    additions: WorkflowSafeguards["additions"],
    etag: string | undefined,
  ): Promise<WorkflowSafeguards> {
    if (isLiveApi) return live.updateWorkflowSafeguards(id, additions, etag)
    await delay(MOCK_DELAY)
    mockSafeguardAdditions.set(id, additions)
    return mockSafeguards(id)
  }

  // workflowId is how answering a clarification re-plans the workflow that
  // raised it. Without it every answer created another draft and planned it
  // with the answer as the goal, losing the objective the user started from.
  async compileWorkflow(_data: { goal: string; answers: Record<string, string>; workflowId?: string; confirm?: true; successCriteria?: string[] }): Promise<{ workflow: Workflow, explanation: string, warnings: any[], questions: string[], plan?: WorkflowPlan; missingConnections?: ConnectionsRequired["missing_connections"] }> {
    const confirmed = _data.confirm ? ConfirmWorkflowBuildSchema.parse({ confirm: _data.confirm, successCriteria: _data.successCriteria }) : undefined
    if (_data.successCriteria !== undefined && !confirmed) throw new Error("Build confirmation is required for edited criteria")
    if (isLiveApi) {
      const newWorkflow = _data.workflowId
        ? await live.getWorkflow(_data.workflowId)
        : await live.createWorkflow(_data.goal);
      const planRes = await live.workflowAction(newWorkflow.id, "plan", { goal: _data.goal, answers: _data.answers, ...confirmed }) as any;

      if (planRes.type === "plan") return { workflow: newWorkflow, explanation: "Review the steps and success criteria, then press Build.", warnings: [], questions: [], plan: WorkflowPlanSchema.parse(planRes) }

      if (planRes.type === "clarification") {
        return {
          workflow: newWorkflow,
          explanation: "I need more details to compile the workflow.",
          warnings: [],
          questions: (planRes.questions ?? []).map((question: unknown) => String(question)),
        };
      }
      
      if (planRes.type === "connections_required") {
        const batch = ConnectionsRequiredSchema.parse(planRes);
        return {
          workflow: newWorkflow,
          explanation: "Connect these accounts, then try planning again.",
          warnings: [], questions: [], missingConnections: batch.missing_connections,
        };
      }
      if (planRes.type !== "compiled") throw new Error("Planner did not return a compiled workflow.");
      if (!confirmed) throw new Error("Planner compiled before Build confirmation.");
      // Successfully compiled - fetch the latest workflow object to get the DAG
      const updatedWorkflow = await live.getWorkflow(newWorkflow.id);
      return {
        workflow: updatedWorkflow,
        explanation: "Workflow compiled successfully.",
        warnings: [],
        questions: [],
      };
    }
    await delay(MOCK_DELAY * 2)
    const newWorkflow = {
      ...mockWorkflows[0]!,
      id: _data.workflowId ?? `wf_${Date.now()}`,
      name: "Generated Workflow",
      status: "draft" as any
    }
    if (confirmed) newWorkflow.dag = compileDag([{ id: "work", type: "LLMTask", position: { x: 0, y: 0 },
      data: { prompt: _data.goal, successCriteria: confirmed.successCriteria } }], [], confirmed.successCriteria)
    const existing = mockWorkflows.findIndex(workflow => workflow.id === newWorkflow.id)
    if (existing < 0) mockWorkflows.push(newWorkflow)
    else mockWorkflows[existing] = newWorkflow
    if (!confirmed) return { workflow: newWorkflow, explanation: "Review the steps and success criteria, then press Build.", warnings: [], questions: [],
      plan: { type: "plan", successCriteria: [_data.goal], steps: [{ key: "work", type: "llm", description: _data.goal, successCriteria: [_data.goal] }] } }
    return {
      workflow: newWorkflow,
      explanation: "Compiled based on your goal.",
      warnings: [],
      questions: []
    }
  }

  async activateWorkflow(_id: string): Promise<void> {
    if (isLiveApi) {
      await live.workflowAction(_id, "activate")
      return
    }
    await delay(MOCK_DELAY)
  }

  // C8, the Deployment Manager: a workflow's real version history and the
  // three things the lifecycle contract lets you do to a version.
  async getWorkflowVersions(id: string): Promise<WorkflowVersion[]> {
    if (isLiveApi) return live.getWorkflowVersions(id)
    await delay(MOCK_DELAY)
    return []
  }

  async testWorkflowVersion(id: string, versionId: string): Promise<void> {
    if (isLiveApi) return live.testWorkflowVersion(id, versionId)
    await delay(MOCK_DELAY)
  }

  async promoteWorkflowVersion(id: string, versionId: string): Promise<void> {
    if (isLiveApi) return live.promoteWorkflowVersion(id, versionId)
    await delay(MOCK_DELAY)
  }

  async startWorkflowVersionCanary(
    id: string,
    versionId: string,
    trafficPercent: number,
  ): Promise<void> {
    if (isLiveApi) return live.startWorkflowVersionCanary(id, versionId, trafficPercent)
    await delay(MOCK_DELAY)
  }

  async rollbackWorkflowVersion(id: string, versionId: string): Promise<void> {
    if (isLiveApi) return live.rollbackWorkflowVersion(id, versionId)
    await delay(MOCK_DELAY)
  }

  async pauseWorkflow(_id: string): Promise<void> {
    if (isLiveApi) {
      await live.workflowAction(_id, "pause")
      return
    }
    await delay(MOCK_DELAY)
  }

  async resumeWorkflow(_id: string): Promise<void> {
    if (isLiveApi) {
      await live.workflowAction(_id, "resume")
      return
    }
    await delay(MOCK_DELAY)
  }

  async saveWorkflowGraph(_id: string, _graph: { nodes: any[], edges: any[]; successCriteria?: string[] }): Promise<void> {
    if (isLiveApi) return live.saveWorkflowGraph(_id, _graph)
    await delay(MOCK_DELAY)
    const workflow = mockWorkflows.find(item => item.id === _id)
    if (!workflow) throw new Error("Workflow was not found")
    const dag = CompiledDagSchema.parse(withNodeOverrideSafeguards(compileDag(_graph.nodes, _graph.edges, _graph.successCriteria), true))
    for (const node of dag.nodes) {
      const original = workflow.dag?.nodes.find(item => item.key === node.key && item.type === node.type)
      delete node.metadata.selection_binding; delete node.metadata.original_choice
      if (original?.metadata.selection_binding) node.metadata.selection_binding = original.metadata.selection_binding
      const choice = original?.metadata.original_choice ?? (original?.type === "LLMTask" ? { kind: "model", value: original.config.model_alias } : original?.type === "ToolCall" ? { kind: "tool", value: original.config.tool_name } : undefined)
      const parsed = NodeOverrideChoiceSchema.safeParse(choice)
      if (parsed.success) node.metadata.original_choice = parsed.data
    }
    workflow.dag = dag
  }

  async simulateWorkflow(_id: string, _input: any): Promise<any> {
    if (isLiveApi) return live.workflowAction(_id, "simulate", _input)
    await delay(MOCK_DELAY * 3)
    const workflow = mockWorkflows.find(item => item.id === _id)
    if (!workflow?.dag) throw new Error("Workflow has no saved canvas to simulate")
    return { trace: workflow.dag.waves.slice().sort((a, b) => a.order - b.order).flatMap(wave =>
      wave.node_keys.map(key => ({ key, type: workflow.dag!.nodes.find(node => node.key === key)?.type ?? "unknown", status: "simulated", input: _input }))) }
  }

  // Projects
  async getProjects(): Promise<Project[]> {
    if (isLiveApi) return live.getProjects()
    await delay(MOCK_DELAY)
    return mockProjects
  }

  async getProject(id: string): Promise<Project> {
    if (isLiveApi) return live.getProject(id)
    await delay(MOCK_DELAY)
    const proj = mockProjects.find(p => p.id === id)
    if (!proj) throw new Error("Project not found")
    return proj
  }

  // Returns the project's id as well as its brief: the planner's questions
  // are addressed to that project, and answering one needs it.
  async compileProjectBrief(data: { goal: string }): Promise<{ projectId: string; brief: ProjectBrief; clarifications: ProjectClarification[] }> {
    if (isLiveApi) {
      const project = await live.createProject(data.goal)
      return {
        projectId: project.id,
        brief: project.brief ?? {
          goal: data.goal,
          primaryUsers: "",
          coreCapabilities: [],
        },
        clarifications: await live.getProjectClarifications(project.id),
      }
    }
    await delay(MOCK_DELAY * 2)
    return {
      projectId: `prj_${Date.now()}`,
      brief: {
        goal: data.goal,
        primaryUsers: "Identified users",
        coreCapabilities: ["Capability 1", "Capability 2"]
      },
      clarifications: [],
    }
  }

  async getProjectClarifications(id: string): Promise<ProjectClarification[]> {
    if (isLiveApi) return live.getProjectClarifications(id)
    await delay(MOCK_DELAY)
    return []
  }

  async answerProjectClarifications(id: string, answers: Record<string, string>): Promise<ProjectClarification[]> {
    if (isLiveApi) {
      // Answered one at a time because that is the route the engine offers;
      // each answer is what lets the planner write the next part of the plan.
      for (const [clarificationId, answer] of Object.entries(answers)) {
        await live.answerProjectClarification(id, clarificationId, answer)
      }
      return live.getProjectClarifications(id)
    }
    await delay(MOCK_DELAY)
    return []
  }

  async approveProjectPlan(_id: string): Promise<void> {
    if (isLiveApi) {
      await live.approveProjectPlan(_id)
      return
    }
    await delay(MOCK_DELAY)
  }

  async startProjectBuild(_id: string): Promise<{ runId: string }> {
    if (isLiveApi) return live.startProjectBuild(_id)
    await delay(MOCK_DELAY)
    return { runId: "run_01JAX77P" } // Mapped to our project run scenario
  }

  async getProjectBuild(id: string): Promise<Run> {
    if (isLiveApi) return live.getProjectBuild(id)
    await delay(MOCK_DELAY)
    // Find the run associated with this project (mocking)
    const run = mockRuns.find(r => r.projectId === id)
    if (!run) throw new Error("Build run not found")
    return run
  }

  async getProjectFiles(_id: string): Promise<ProjectFile[]> {
    if (isLiveApi) return live.getProjectFiles(_id)
    await delay(MOCK_DELAY)
    return [
      { id: "f_1", path: "src", name: "src", type: "directory" },
      { id: "f_2", path: "src/app", name: "app", type: "directory" },
      { id: "f_3", path: "src/app/App.tsx", name: "App.tsx", type: "file", language: "typescript", status: "unchanged" },
      { id: "f_4", path: "src/components", name: "components", type: "directory" },
      { id: "f_5", path: "src/components/Button.tsx", name: "Button.tsx", type: "file", language: "typescript", status: "unchanged" },
      { id: "f_6", path: "src/main.tsx", name: "main.tsx", type: "file", language: "typescript", status: "modified" },
    ]
  }

  async getProjectChanges(_id: string): Promise<ProjectFile[]> {
    if (isLiveApi) return live.getProjectFiles(_id)
    await delay(MOCK_DELAY)
    return [
      { id: "f_6", path: "src/main.tsx", name: "main.tsx", type: "file", language: "typescript", status: "modified", content: "- import { App } from './App'\n+ import { App } from './app/App'" },
    ]
  }

  async getProjectTests(_id: string): Promise<TestResult[]> {
    if (isLiveApi) return live.getProjectTests(_id)
    await delay(MOCK_DELAY)
    return [
      { id: "t_1", name: "Authentication renders", status: "passed", durationMs: 145 },
      { id: "t_2", name: "Sidebar navigation works", status: "passed", durationMs: 234 },
      { id: "t_3", name: "Dashboard loads workflows", status: "failed", error: "Expected 'Customer Support' to be visible, but element was not found.", durationMs: 405 },
      { id: "t_4", name: "Mobile navigation", status: "skipped" }
    ]
  }

  async getProjectAudit(_id: string): Promise<{ category: string, status: string, message: string }[]> {
    if (isLiveApi) return live.getProjectAudit(_id)
    await delay(MOCK_DELAY)
    return [
      { category: "TypeScript", status: "pass", message: "No TypeScript errors detected." },
      { category: "Accessibility", status: "warning", message: "2 icon-only buttons require labels." },
      { category: "Security", status: "pass", message: "No insecure dependencies found." }
    ]
  }

  async getProjectPreview(_id: string): Promise<{ url: string, status: string }> {
    if (isLiveApi) return live.getProjectPreview(_id)
    await delay(MOCK_DELAY)
    return { url: "about:blank", status: "ready" }
  }

  // Human Actions
  async getHumanActions(filters?: HumanActionFilters): Promise<HumanAction[]> {
    if (isLiveApi) return live.getHumanActions(filters)
    await delay(MOCK_DELAY)
    let actions = [...mockHumanActions]
    actions = actions.filter(a => live.humanActionInTab(a.status, filters?.status))
    if (filters?.type) actions = actions.filter(a => a.type === filters.type)
    return actions
  }

  async getHumanAction(id: string): Promise<HumanAction> {
    if (isLiveApi) return live.getHumanAction(id)
    await delay(MOCK_DELAY)
    const action = mockHumanActions.find(a => a.id === id)
    if (!action) throw new Error("Human action not found")
    return action
  }

  async claimHumanAction(id: string): Promise<HumanAction> {
    if (isLiveApi) return live.claimHumanAction(id)
    await delay(MOCK_DELAY)
    const action = mockHumanActions.find(a => a.id === id)
    if (!action) throw new Error("Human action not found")
    if (action.status !== "open") throw new Error("Action is not open")
    action.status = "claimed"
    action.claimedBy = { id: "usr_1", name: "Ameen" }
    action.claimedAt = new Date().toISOString()
    return action
  }

  async approveHumanAction(id: string, payload?: any): Promise<HumanAction> {
    if (isLiveApi) return live.approveHumanAction(id, payload)
    await delay(MOCK_DELAY)
    const action = mockHumanActions.find(a => a.id === id)
    if (!action) throw new Error("Human action not found")
    action.status = "resolved"
    action.resolution = "approved"
    action.resolvedBy = { id: "usr_1", name: "Ameen" }
    action.resolvedAt = new Date().toISOString()
    return action
  }

  async rejectHumanAction(id: string, payload?: any): Promise<HumanAction> {
    if (isLiveApi) return live.rejectHumanAction(id, payload)
    await delay(MOCK_DELAY)
    const action = mockHumanActions.find(a => a.id === id)
    if (!action) throw new Error("Human action not found")
    action.status = "resolved"
    action.resolution = "rejected"
    action.resolvedBy = { id: "usr_1", name: "Ameen" }
    action.resolvedAt = new Date().toISOString()
    return action
  }

  async answerHumanAction(id: string, payload: any): Promise<HumanAction> {
    if (isLiveApi) return live.answerHumanAction(id, payload)
    await delay(MOCK_DELAY)
    const action = mockHumanActions.find(a => a.id === id)
    if (!action) throw new Error("Human action not found")
    action.status = "resolved"
    action.resolution = "answered"
    action.resolvedBy = { id: "usr_1", name: "Ameen" }
    action.resolvedAt = new Date().toISOString()
    return action
  }

  async resolveHumanAction(id: string, payload?: any): Promise<HumanAction> {
    if (isLiveApi) return live.resolveHumanAction(id, payload)
    await delay(MOCK_DELAY)
    const action = mockHumanActions.find(a => a.id === id)
    if (!action) throw new Error("Human action not found")
    action.status = "resolved"
    action.resolution = "resolved"
    action.resolvedBy = { id: "usr_1", name: "Ameen" }
    action.resolvedAt = new Date().toISOString()
    return action
  }

  async getHumanActionHistory(type: HumanActionType, id: string): Promise<HumanAnnotation[]> {
    if (isLiveApi) return live.getHumanActionHistory(type, id)
    await delay(MOCK_DELAY)
    return mockHumanAnnotations.filter(a => a.actionId === id)
  }

  async addHumanAnnotation(type: HumanActionType, id: string, text: string): Promise<HumanAnnotation> {
    if (isLiveApi) return live.addHumanAnnotation(type, id, text)
    await delay(MOCK_DELAY)
    const annotation: HumanAnnotation = {
      id: `ann_${Date.now()}`,
      actionId: id,
      author: { id: "usr_1", name: "Ameen" },
      text,
      createdAt: new Date().toISOString()
    }
    mockHumanAnnotations.push(annotation)
    return annotation
  }

  // Recovery
  async getRecoveryHistory(runId: string): Promise<RecoveryEvent[]> {
    if (isLiveApi) return live.getRecoveryHistory(runId)
    await delay(MOCK_DELAY)
    return mockRecoveryEvents.filter(e => e.runId === runId)
  }

  // Workflow Health
  async getWorkflowHealths(cursor?: string): Promise<WorkflowHealthCollection> {
    if (isLiveApi) return live.getWorkflowHealths(cursor)
    await delay(MOCK_DELAY)
    return { data: mockWorkflowHealth, page: { next_cursor: null, has_more: false, limit: 50 } }
  }

  async getWorkflowHealth(workflowId: string): Promise<WorkflowHealth> {
    if (isLiveApi) return live.getWorkflowHealth(workflowId)
    await delay(MOCK_DELAY)
    const health = mockWorkflowHealth.find(h => h.workflowId === workflowId)
    if (!health) throw new Error("Workflow health not found")
    return health
  }

  // Node Verification
  async getNodeVerification(runId: string, nodeId: string): Promise<NodeVerification> {
    if (isLiveApi) return live.getNodeVerification(runId, nodeId)
    await delay(MOCK_DELAY)
    if (nodeId === "node_refund") {
      return {
        status: "passed",
        summary: "Refund transaction simulated successfully",
        checks: [
          { id: "c1", name: "Amount check", status: "passed", message: "Amount is within limits" }
        ]
      }
    }
    return {
      status: "warning",
      summary: "Node execution returned partial results",
      checks: [
        { id: "c1", name: "Schema check", status: "passed" },
        { id: "c2", name: "Confidence threshold", status: "warning", message: "0.71 < 0.80" }
      ]
    }
  }

  // Phase 6: Conversations
  async getConversations(filters?: { type?: Conversation["type"] }): Promise<Conversation[]> {
    if (isLiveApi) return live.getConversations(filters)
    await delay(MOCK_DELAY)
    let convs = [...mockConversations]
    if (filters?.type) convs = convs.filter(c => c.type === filters.type)
    return convs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  async getConversation(id: string): Promise<Conversation> {
    if (isLiveApi) return live.getConversation(id)
    await delay(MOCK_DELAY)
    const conv = mockConversations.find(c => c.id === id)
    if (!conv) throw new Error("Conversation not found")
    return conv
  }

  async createConversation(data: { type: string; title: string; linkedWorkflowId?: string; linkedProjectId?: string; linkedRunId?: string }): Promise<Conversation> {
    if (isLiveApi) return live.createConversation(data)
    await delay(MOCK_DELAY)
    let linkedWorkflowId = data.linkedWorkflowId
    if (data.type === "workflow_builder" && !linkedWorkflowId) {
      linkedWorkflowId = `wf_${Date.now()}`
      mockWorkflows.push({ ...mockWorkflows[0]!, id: linkedWorkflowId, name: data.title, status: "draft", runs: 0 })
    }
    const conv: Conversation = {
      id: `conv_${Date.now()}`,
      title: data.title,
      type: data.type as any,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: { id: "usr_1", name: "Ameen" },
      linkedWorkflowId,
      linkedProjectId: data.linkedProjectId,
      linkedRunId: data.linkedRunId,
      preview: "New conversation started."
    }
    mockConversations.push(conv)
    mockConversationMessages[conv.id] = []
    return conv
  }

  async getConversationMessages(id: string): Promise<ConversationMessage[]> {
    if (isLiveApi) return live.getConversationMessages(id)
    await delay(MOCK_DELAY)
    return mockConversationMessages[id] || []
  }

  async sendMessage(id: string, payload: { content: any; kind?: string; build?: { planMessageId: string; successCriteria: string[] } }): Promise<{ userMessage: ConversationMessage; assistantMessage?: ConversationMessage }> {
    if (isLiveApi) return live.sendMessage(id, payload)
    await delay(MOCK_DELAY)
    if (!mockConversationMessages[id]) {
      mockConversationMessages[id] = []
    }
    
    const userMessage: ConversationMessage = {
      id: `msg_${Date.now()}`,
      conversationId: id,
      role: "user",
      kind: (payload.kind as any) || "text",
      createdAt: new Date().toISOString(),
      content: payload.build ? { text: payload.content, build: payload.build } : payload.content
    }
    mockConversationMessages[id].push(userMessage)

    const conv = mockConversations.find(c => c.id === id)
    if (conv) {
      conv.updatedAt = new Date().toISOString()
      conv.preview = typeof payload.content === 'string' ? payload.content : "Sent a message"
    }

    // Deterministic mock assistant response
    let assistantMessage: ConversationMessage | undefined
    
    await delay(MOCK_DELAY * 2) // Simulate thinking
    
    if (conv?.type === "workflow_builder" && typeof payload.content === "string") {
      const history = mockConversationMessages[id]!
      const latest = [...history].reverse().find(message => message.role === "assistant" && message.kind === "artifact" && typeof message.content === "object" && message.content.type === "plan")
      if (payload.build && (latest?.id !== payload.build.planMessageId || history.slice(history.indexOf(latest!) + 1).some(message => message.role === "assistant" && message.kind === "workflow"))) throw new Error("Review the latest plan before pressing Build")
      const goal = payload.build && latest && typeof latest.content === "object" ? String(latest.content.objective) : payload.content
      const result = await this.compileWorkflow({ goal, answers: {}, workflowId: conv.linkedWorkflowId,
        ...(payload.build ? { confirm: true, successCriteria: payload.build.successCriteria } : {}) })
      assistantMessage = { id: `msg_${Date.now() + 1}`, conversationId: id, role: "assistant", kind: result.plan ? "artifact" : "workflow", createdAt: new Date().toISOString(),
        content: result.plan ? { ...result.plan, objective: goal, text: result.explanation } : { text: result.explanation, workflowId: result.workflow.id } }
      history.push(assistantMessage)
    } else if (typeof payload.content === 'string') {
      const text = payload.content.toLowerCase()
      
      if (text.includes("build") || text.includes("create")) {
        assistantMessage = {
          id: `msg_${Date.now() + 1}`,
          conversationId: id,
          role: "assistant",
          kind: "action",
          createdAt: new Date().toISOString(),
          content: {
            text: "I can help with that. Should we create a new Workflow or a new Project?",
            actions: [
              { label: "Create Workflow", href: "/app/workflows/new" },
              { label: "Create Project", href: "/app/projects/new" }
            ]
          }
        }
      } else if (text.includes("fail") || text.includes("error")) {
        assistantMessage = {
          id: `msg_${Date.now() + 1}`,
          conversationId: id,
          role: "assistant",
          kind: "run",
          createdAt: new Date().toISOString(),
          content: {
            summary: "I found a recent run that failed.",
            runId: "run_01JAX48P",
            error: "Failed at node validation."
          }
        }
      } else {
        assistantMessage = {
          id: `msg_${Date.now() + 1}`,
          conversationId: id,
          role: "assistant",
          kind: "text",
          createdAt: new Date().toISOString(),
          content: "I am AlterX. I can help you build workflows, investigate runs, or manage your projects. What would you like to do?"
        }
      }
      
      if (assistantMessage) {
        mockConversationMessages[id].push(assistantMessage)
      }
    }

    return { userMessage, assistantMessage }
  }

  async archiveConversation(id: string): Promise<void> {
    if (isLiveApi) return live.archiveConversation(id)
    await delay(MOCK_DELAY)
    const conv = mockConversations.find(c => c.id === id)
    if (conv) conv.status = "archived"
  }

  async createConversationDraft(id: string): Promise<Conversation> {
    if (isLiveApi) return live.createConversationDraft(id)
    return this.createConversation({ type: "workflow_builder", title: "New workflow" })
  }

  // Phase 6: Triggers
  async getTriggers(workflowId: string): Promise<Trigger[]> {
    if (isLiveApi) return live.getTriggers(workflowId)
    await delay(MOCK_DELAY)
    return mockTriggers.filter(t => t.workflowId === workflowId)
  }

  async getTrigger(id: string): Promise<Trigger> {
    if (isLiveApi) return live.getTrigger(id)
    await delay(MOCK_DELAY)
    const t = mockTriggers.find(t => t.id === id)
    if (!t) throw new Error("Trigger not found")
    return t
  }

  async createTrigger(data: Partial<Trigger>): Promise<Trigger> {
    if (isLiveApi) return live.createTrigger(data)
    await delay(MOCK_DELAY)
    const t: Trigger = {
      id: `trg_${Date.now()}`,
      workflowId: data.workflowId!,
      type: data.type!,
      name: data.name || "New Trigger",
      enabled: false,
      status: "needs_configuration",
      config: data.config || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockTriggers.push(t)
    return t
  }

  async getHostedForm(id: string): Promise<HostedFormSetup> {
    if (isLiveApi) return live.getHostedForm(id)
    await delay(MOCK_DELAY)
    const form = this.hostedForms.get(id)
    if (!form) throw new Error("Hosted form not found")
    return structuredClone(form)
  }

  async createHostedForm(workflowId: string, workflowVersionId: string, definition: HostedFormDefinition): Promise<Trigger> {
    if (isLiveApi) return live.createHostedForm(workflowId, workflowVersionId, definition)
    await delay(MOCK_DELAY)
    const form = HostedFormDefinitionSchema.parse(definition)
    const id = `trg_${crypto.randomUUID().replace(/^(.{14})./, (_, prefix: string) => `${prefix}7`)}`
    const trigger: Trigger = { id, workflowId, provider: "alter_public_form", type: "webhook", name: form.title, enabled: false,
      status: "configured", config: { publicForm: form }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const versionId = `trv_${crypto.randomUUID().replace(/^(.{14})./, (_, prefix: string) => `${prefix}7`)}`
    const setup: HostedFormSetup = { definition: form, workflowVersionId, triggerVersionId: versionId, version: 1, status: "draft",
      publicUrl: `https://forms.example.test/f/mock-${versionId}`, etag: `"public-form-${versionId}-draft"` }
    mockTriggers.push(trigger)
    this.hostedForms.set(id, setup)
    return structuredClone(trigger)
  }

  async updateHostedForm(id: string, definition: HostedFormDefinition, workflowVersionId: string, ifMatch: string): Promise<HostedFormSetup> {
    if (isLiveApi) return live.updateHostedForm(id, definition, workflowVersionId, ifMatch)
    await delay(MOCK_DELAY)
    const current = this.hostedForms.get(id)
    if (!current) throw new Error("Hosted form not found")
    if (current.etag !== ifMatch) throw new Error("Form changed. Reload before saving.")
    const versionId = `trv_${crypto.randomUUID().replace(/^(.{14})./, (_, prefix: string) => `${prefix}7`)}`
    const setup = { ...current, definition: HostedFormDefinitionSchema.parse(definition), workflowVersionId,
      version: current.version + 1, triggerVersionId: versionId, publicUrl: `https://forms.example.test/f/mock-${versionId}`,
      etag: `"public-form-${versionId}-${current.status}"` }
    this.hostedForms.set(id, setup)
    return structuredClone(setup)
  }

  async setHostedFormStatus(id: string, status: "enabled" | "disabled" | "archived", ifMatch: string): Promise<Trigger> {
    if (isLiveApi) return live.setHostedFormStatus(id, status, ifMatch)
    await delay(MOCK_DELAY)
    const current = this.hostedForms.get(id)
    const trigger = mockTriggers.find(t => t.id === id)
    if (!current || !trigger) throw new Error("Hosted form not found")
    if (current.etag !== ifMatch) throw new Error("Form changed. Reload before saving.")
    if (current.status === "archived") throw new Error("Form is archived")
    this.hostedForms.set(id, { ...current, status, etag: `"public-form-${current.triggerVersionId}-${status}"` })
    trigger.enabled = status === "enabled"
    trigger.status = status === "archived" ? "needs_configuration" : "configured"
    if (status === "archived") mockTriggers.splice(mockTriggers.indexOf(trigger), 1)
    return structuredClone(trigger)
  }

  async updateTrigger(id: string, data: Partial<Trigger>): Promise<Trigger> {
    if (isLiveApi) return live.updateTrigger(id, data)
    await delay(MOCK_DELAY)
    const t = mockTriggers.find(t => t.id === id)
    if (!t) throw new Error("Trigger not found")
    Object.assign(t, data, { updatedAt: new Date().toISOString() })
    return t
  }

  async testTrigger(id: string): Promise<{ success: boolean; message: string; eventId?: string }> {
    if (isLiveApi) return live.testTrigger(id)
    await delay(MOCK_DELAY * 2)
    const t = mockTriggers.find(t => t.id === id)
    if (!t) throw new Error("Trigger not found")
    t.lastTestedAt = new Date().toISOString()
    
    if (t.type === "webhook") {
      return { success: true, message: "Webhook payload accepted.", eventId: "evt_01" }
    } else {
      return { success: false, message: "Required field missing in mock payload." }
    }
  }

  async enableTrigger(id: string): Promise<Trigger> {
    if (isLiveApi) return live.enableTrigger(id)
    await delay(MOCK_DELAY)
    const t = mockTriggers.find(t => t.id === id)
    if (!t) throw new Error("Trigger not found")
    if (t.status === "error" || t.status === "needs_configuration") {
      throw new Error("Cannot enable a trigger that needs configuration.")
    }
    t.enabled = true
    t.updatedAt = new Date().toISOString()
    return t
  }

  async disableTrigger(id: string): Promise<Trigger> {
    if (isLiveApi) return live.disableTrigger(id)
    await delay(MOCK_DELAY)
    const t = mockTriggers.find(t => t.id === id)
    if (!t) throw new Error("Trigger not found")
    t.enabled = false
    t.updatedAt = new Date().toISOString()
    return t
  }

  async removeTrigger(id: string): Promise<void> {
    if (isLiveApi) return live.removeTrigger(id)
    await delay(MOCK_DELAY)
    const index = mockTriggers.findIndex(t => t.id === id)
    if (index > -1) mockTriggers.splice(index, 1)
  }

  // Phase 6: Webhooks
  async getWebhooks(): Promise<WebhookEndpoint[]> {
    if (isLiveApi) return live.getWebhooks()
    await delay(MOCK_DELAY)
    return mockWebhooks
  }

  // Phase 6: Events
  async getEvents(filters?: any): Promise<IncomingEvent[]> {
    if (isLiveApi) return live.getEvents(filters)
    await delay(MOCK_DELAY)
    let events = [...mockEvents]
    if (filters?.source) events = events.filter(e => e.source === filters.source)
    if (filters?.status) events = events.filter(e => e.status === filters.status)
    return events.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }

  async getEvent(id: string): Promise<IncomingEvent> {
    if (isLiveApi) return live.getEvent(id)
    await delay(MOCK_DELAY)
    const e = mockEvents.find(e => e.id === id)
    if (!e) throw new Error("Event not found")
    return e
  }

  async replayEvent(id: string): Promise<import("./types").EventReplayPreview> {
    if (isLiveApi) return live.replayEvent(id)
    const event = await api.getEvent(id)
    if (!event.workflowId) throw new Error("This event has no matched workflow to replay")
    const result = await api.simulateWorkflow(event.workflowId, event.payload ?? {})
    const workflow = await api.getWorkflow(event.workflowId)
    const actions = workflow.dag!.nodes.filter(node => node.type === "ToolCall" && typeof node.config["tool_name"] === "string" &&
      hasExternalSideEffect(node.config["tool_name"])).map(node => ({ nodeKey: node.key, toolName: String(node.config["tool_name"]) }))
    return { mode: "dry_run", eventId: id, workflowId: event.workflowId, workflowVersionId: "mock",
      payload: event.payload ?? {}, trace: result.trace, actions, confirmationToken: JSON.stringify({ id, payload: event.payload ?? {}, dag: workflow.dag }) }
  }

  async replayEventForReal(id: string, confirmationToken: string, requestKey?: string): Promise<{ runId: string; replayedFrom: string }> {
    if (isLiveApi) return live.replayEventForReal(id, confirmationToken, requestKey)
    const event = await api.getEvent(id)
    const preview = await api.replayEvent(id)
    if (!event.workflowId || confirmationToken !== preview.confirmationToken) throw new Error("Preview and confirm this event before replaying")
    await delay(MOCK_DELAY * 2)
    const runId = `run_${requestKey ?? crypto.randomUUID()}`
    const existing = mockRuns.find(item => item.id === runId)
    if (existing) {
      if (existing.triggeredBy?.id !== id) throw new Error("Idempotency key already used for a different event")
      return { runId: existing.id, replayedFrom: id }
    }
    const run: Run = { id: runId, workflowId: event.workflowId, mode: "workflow", status: "queued", createdAt: new Date().toISOString(), triggeredBy: { id, name: "Event replay" } }
    mockRuns.push(run)
    return { runId: run.id, replayedFrom: id }
  }

  // Phase 6: Dashboard Aggregates
  async getDashboardOverview(): Promise<DashboardOverview> {
    if (isLiveApi) return live.getDashboardOverview(mockDashboardOverview)
    await delay(MOCK_DELAY)
    return mockDashboardOverview
  }

  // Phase 7: Knowledge API
  async getKnowledgeSources(): Promise<KnowledgeSource[]> {
    if (isLiveApi) return live.getKnowledgeSources()
    await delay(MOCK_DELAY)
    return mockKnowledgeSources.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  async getKnowledgeSource(id: string): Promise<KnowledgeSource> {
    if (isLiveApi) return live.getKnowledgeSource(id)
    await delay(MOCK_DELAY)
    const s = mockKnowledgeSources.find(s => s.id === id)
    if (!s) throw new Error("Knowledge source not found")
    return s
  }

  async createKnowledgeSource(data: Partial<KnowledgeSource>): Promise<KnowledgeSource> {
    if (isLiveApi) return live.createKnowledgeSource(data)
    await delay(MOCK_DELAY * 2)
    const s: KnowledgeSource = {
      id: `ks_${Date.now()}`,
      name: data.name || "New Source",
      type: data.type || "file_upload",
      status: "processing",
      documentCount: data.documentCount || 0,
      chunkCount: data.chunkCount || 0,
      connectionId: data.connectionId,
      config: data.config,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockKnowledgeSources.push(s)
    return s
  }

  async syncKnowledgeSource(id: string): Promise<KnowledgeSource> {
    if (isLiveApi) return live.syncKnowledgeSource(id)
    await delay(MOCK_DELAY * 2)
    const s = mockKnowledgeSources.find(s => s.id === id)
    if (!s) throw new Error("Source not found")
    s.status = "syncing"
    s.updatedAt = new Date().toISOString()
    return s
  }

  async deleteKnowledgeSource(id: string): Promise<void> {
    if (isLiveApi) return live.deleteKnowledgeSource(id)
    await delay(MOCK_DELAY)
    const idx = mockKnowledgeSources.findIndex(s => s.id === id)
    if (idx > -1) mockKnowledgeSources.splice(idx, 1)
  }

  async getKnowledgeDocuments(sourceId: string): Promise<KnowledgeDocument[]> {
    if (isLiveApi) return live.getKnowledgeDocuments(sourceId)
    await delay(MOCK_DELAY)
    return mockKnowledgeDocuments.filter(d => d.sourceId === sourceId)
  }

  async retryKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
    if (isLiveApi) return live.retryKnowledgeDocument(id)
    await delay(MOCK_DELAY)
    const d = mockKnowledgeDocuments.find(d => d.id === id)
    if (!d) throw new Error("Document not found")
    d.status = "processing"
    d.error = undefined
    return d
  }

  async deleteKnowledgeDocument(id: string): Promise<void> {
    if (isLiveApi) return live.deleteKnowledgeDocument(id)
    await delay(MOCK_DELAY)
    const index = mockKnowledgeDocuments.findIndex(doc => doc.id === id)
    if (index === -1) throw new Error("Document not found")
    const [document] = mockKnowledgeDocuments.splice(index, 1)
    for (let i = mockKnowledgeChunks.length - 1; i >= 0; i--) {
      if (mockKnowledgeChunks[i].documentId === id) mockKnowledgeChunks.splice(i, 1)
    }
    const source = mockKnowledgeSources.find(source => source.id === document.sourceId)
    if (source) {
      source.documentCount = Math.max(0, source.documentCount - 1)
      source.chunkCount = Math.max(0, source.chunkCount - (document.chunkCount ?? 0))
      source.updatedAt = new Date().toISOString()
    }
  }

  async testRetrieval(query: string, filters?: any): Promise<RetrievalResult[]> {
    if (isLiveApi) return live.testRetrieval(query, filters)
    await delay(MOCK_DELAY * 2)
    
    if (filters?.sources?.includes("ks_03")) { // Mock syncing source
       throw new Error("One selected source is still indexing.")
    }
    
    if (query.toLowerCase().includes("empty") || query.toLowerCase().includes("none")) {
       return []
    }
    
    // Return mock results
    return [
      {
        id: `res_${Date.now()}_1`,
        chunkId: "chunk_018",
        sourceId: "ks_02",
        documentId: "doc_01",
        content: "Annual subscriptions may receive a prorated refund if cancelled within the first 30 days of the billing cycle. After 30 days, no refunds will be issued for annual plans.",
        score: 0.92,
        confidence: "high",
        provenance: [
          {
            id: "prov_1",
            sourceId: "ks_02",
            sourceName: "Support Policies",
            documentId: "doc_01",
            documentName: "refund-policy.pdf",
            chunkId: "chunk_018",
          }
        ]
      },
      {
        id: `res_${Date.now()}_2`,
        chunkId: "chunk_019",
        sourceId: "ks_02",
        documentId: "doc_01",
        content: "Monthly subscriptions are non-refundable. If you cancel a monthly subscription, you will retain access to the platform until the end of your current billing period.",
        score: 0.78,
        confidence: "medium",
        provenance: [
          {
            id: "prov_2",
            sourceId: "ks_02",
            sourceName: "Support Policies",
            documentId: "doc_01",
            documentName: "refund-policy.pdf",
            chunkId: "chunk_019",
          }
        ]
      }
    ]
  }

  async getMemoryConfiguration(): Promise<MemoryConfiguration> {
    if (isLiveApi) return liveMemorySettings.getMemoryConfiguration()
    await delay(MOCK_DELAY)
    return mockMemoryConfig
  }

  async updateMemoryConfiguration(data: Partial<MemoryConfiguration>): Promise<MemoryConfiguration> {
    if (isLiveApi) return liveMemorySettings.updateMemoryConfiguration(data)
    await delay(MOCK_DELAY)
    Object.assign(mockMemoryConfig, data)
    return mockMemoryConfig
  }

  async requestDataExport(workspaceId?: string): Promise<{ status: string; id?: string }> {
    if (isLiveApi && workspaceId) {
      const created = await liveDataExport.requestDataExport(workspaceId)
      return { status: created.status, id: created.id }
    }
    await delay(MOCK_DELAY * 2)
    return { status: "ready" } // Mock direct readiness
  }

  async listDataExports(workspaceId: string): Promise<liveDataExport.DataExport[]> {
    if (isLiveApi) return liveDataExport.listDataExports(workspaceId)
    await delay(MOCK_DELAY)
    return []
  }

  async getDataExport(workspaceId: string, exportId: string): Promise<liveDataExport.DataExport> {
    if (isLiveApi) return liveDataExport.getDataExport(workspaceId, exportId)
    await delay(MOCK_DELAY)
    return { id: exportId, workspaceId, status: "ready", failureReason: null, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: null }
  }

  async downloadDataExport(workspaceId: string, exportId: string): Promise<liveDataExport.DataExportArchive> {
    if (isLiveApi) return liveDataExport.downloadDataExport(workspaceId, exportId)
    await delay(MOCK_DELAY)
    return { exportedAt: new Date().toISOString(), workspaceId, workflows: [], workflowVersions: [], runs: [], knowledgeSources: [], knowledgeDocuments: [], members: [] }
  }
  
  async deleteWorkspaceData(_scope: string): Promise<void> {
    await delay(MOCK_DELAY * 3)
  }

  // Phase 7: Connections API
  async getIntegrationCatalog(): Promise<IntegrationDefinition[]> {
    if (isLiveApi) return live.getIntegrationCatalog()
    await delay(MOCK_DELAY)
    return mockIntegrationDefinitions
  }

  async getIntegration(id: string): Promise<IntegrationDefinition> {
    if (isLiveApi) return live.getIntegration(id)
    await delay(MOCK_DELAY)
    const i = mockIntegrationDefinitions.find(i => i.id === id)
    if (!i) throw new Error("Integration not found")
    return i
  }

  async getConnections(): Promise<Connection[]> {
    if (isLiveApi) return live.getConnections()
    await delay(MOCK_DELAY)
    return mockConnections.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  async getConnection(id: string): Promise<Connection> {
    if (isLiveApi) return live.getConnection(id)
    await delay(MOCK_DELAY)
    const c = mockConnections.find(c => c.id === id)
    if (!c) throw new Error("Connection not found")
    return c
  }

  async createConnection(data: Partial<Connection>): Promise<Connection> {
    // Not wired to the live API -- the real backend requires a genuine
    // OAuth authorize/callback redirect round trip
    // (POST /api/v1/integrations/:connector/actions/authorize +
    // .../actions/callback) that the frontend has never implemented.
    // connect-flow-dialog.tsx's own code admits this: it mocks creating
    // the connection directly with a fake setTimeout "simulate OAuth
    // redirect" instead of a real one. Wiring this straight to a REST
    // call would silently create a connection with no real OAuth token
    // behind it. See PR description for what the real flow needs.
    await delay(MOCK_DELAY * 2)
    const c: Connection = {
      id: `conn_${Date.now()}`,
      integrationId: data.integrationId!,
      name: data.name || "New Connection",
      status: "connected",
      credentialId: data.credentialId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString()
    }
    mockConnections.push(c)
    return c
  }

  async testConnection(id: string): Promise<{ success: boolean; message: string }> {
    if (isLiveApi) return live.testConnection(id)
    await delay(MOCK_DELAY * 2)
    const c = mockConnections.find(c => c.id === id)
    if (!c) throw new Error("Connection not found")
    c.lastCheckedAt = new Date().toISOString()

    if (c.status === "expired" || c.status === "error") {
      return { success: false, message: "Connection test failed. Invalid credentials or expired token." }
    }
    return { success: true, message: "Connection test successful." }
  }

  async reconnectConnection(id: string): Promise<Connection> {
    // Not wired -- same real OAuth redirect gap as createConnection
    // (see PR description). No UI call site currently exists either.
    await delay(MOCK_DELAY * 2)
    const c = mockConnections.find(c => c.id === id)
    if (!c) throw new Error("Connection not found")
    c.status = "connected"
    c.lastCheckedAt = new Date().toISOString()
    return c
  }

  async deleteConnection(id: string): Promise<void> {
    if (isLiveApi) return live.deleteConnection(id)
    await delay(MOCK_DELAY)
    const idx = mockConnections.findIndex(c => c.id === id)
    if (idx > -1) mockConnections.splice(idx, 1)
  }

  // Phase 7: Credentials API
  async getCredentials(): Promise<Credential[]> {
    if (isLiveApi) return live.getCredentials()
    await delay(MOCK_DELAY)
    return mockCredentials.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }
  
  async getCredential(id: string): Promise<Credential> {
    if (isLiveApi) return live.getCredential(id)
    await delay(MOCK_DELAY)
    const c = mockCredentials.find(c => c.id === id)
    if (!c) throw new Error("Credential not found")
    return c
  }

  async createCredential(data: {
    name: string
    connector: string
    scope: string
    value: string
  }): Promise<Credential> {
    if (isLiveApi) return live.createCredential(data)
    await delay(MOCK_DELAY * 2)
    const c: Credential = {
      id: `cred_${Date.now()}`,
      name: data.name,
      type: "secret",
      provider: data.connector,
      maskedValue: "sk_••••••••",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usedByConnectionIds: []
    }
    mockCredentials.push(c)
    return c
  }

  async updateCredential(id: string, data: { name?: string; connector?: string; scope?: string }): Promise<Credential> {
    if (isLiveApi) return live.updateCredential(id, data)
    await delay(MOCK_DELAY)
    const c = mockCredentials.find(c => c.id === id)
    if (!c) throw new Error("Credential not found")
    Object.assign(c, data, { updatedAt: new Date().toISOString() })
    return c
  }

  async replaceCredentialSecret(id: string, secretValue: string): Promise<Credential> {
    if (isLiveApi) return live.replaceCredentialSecret(id, secretValue)
    await delay(MOCK_DELAY)
    const c = mockCredentials.find(c => c.id === id)
    if (!c) throw new Error("Credential not found")
    c.updatedAt = new Date().toISOString()
    return c
  }

  async deleteCredential(id: string): Promise<void> {
    if (isLiveApi) return live.deleteCredential(id)
    await delay(MOCK_DELAY)
    const c = mockCredentials.find(c => c.id === id)
    if (!c) throw new Error("Credential not found")
    if (c.usedByConnectionIds.length > 0) {
      throw new Error("Credential is in use by one or more connections.")
    }
    const idx = mockCredentials.findIndex(c => c.id === id)
    if (idx > -1) mockCredentials.splice(idx, 1)
  }

  // Phase 7: Channels API
  async getWhatsAppChannels(): Promise<WhatsAppChannel[]> {
    if (isLiveApi) return live.getWhatsAppChannels()
    await delay(MOCK_DELAY)
    return mockWhatsAppChannels
  }

  async createWhatsAppChannel(data: Partial<WhatsAppChannel>): Promise<WhatsAppChannel> {
    if (isLiveApi) return live.createWhatsAppChannel(data)
    await delay(MOCK_DELAY * 2)
    const ch: WhatsAppChannel = {
      id: `wa_${Date.now()}`,
      name: data.name || "New Channel",
      phoneNumber: data.phoneNumber!,
      provider: data.provider || "mock",
      status: "connected",
      connectionId: data.connectionId,
      createdAt: new Date().toISOString(),
    }
    mockWhatsAppChannels.push(ch)
    return ch
  }

  async getWhatsAppTemplates(id: string): Promise<WhatsAppTemplate[]> {
    if (isLiveApi) return live.getWhatsAppTemplates(id)
    await delay(MOCK_DELAY)
    if (!mockWhatsAppChannels.some(channel => channel.id === id)) throw new Error("WhatsApp account not found")
    return [{ name: "hello_world", language: "en_US", status: "APPROVED" }]
  }

  async testWhatsAppChannel(id: string, message: WhatsAppTestMessage, requestKey: string): Promise<{ messageId: string }> {
    if (isLiveApi) return live.testWhatsAppChannel(id, message, requestKey)
    const templates = await this.getWhatsAppTemplates(id)
    if (!/^[1-9][0-9]{6,14}$/.test(message.to) || !templates.some(template => template.name === message.templateName && template.language === message.languageCode)) {
      throw new Error("Enter a recipient and select an approved template")
    }
    return { messageId: `mock-${id}-${requestKey}` }
  }

  async deleteWhatsAppChannel(id: string): Promise<void> {
    if (isLiveApi) return live.deleteWhatsAppChannel(id)
    await delay(MOCK_DELAY)
    const idx = mockWhatsAppChannels.findIndex(c => c.id === id)
    if (idx > -1) mockWhatsAppChannels.splice(idx, 1)
  }


  // Repository Manager (task 5.2). Mock mode keeps an in-memory list so the
  // page is usable without a GitHub connection; live mode calls platform-api.
  async getRepositories(): Promise<RepositoryBinding[]> {
    if (isLiveApi) return live.getRepositories()
    await delay(MOCK_DELAY)
    return [...mockRepositoryBindings]
  }

  async getAvailableRepositories(connectionId: string): Promise<AvailableRepository[]> {
    if (isLiveApi) return live.getAvailableRepositories(connectionId)
    await delay(MOCK_DELAY)
    return mockAvailableRepositories
  }

  async bindRepository(connectionId: string, fullName: string): Promise<RepositoryBinding> {
    if (isLiveApi) return live.bindRepository(connectionId, fullName)
    await delay(MOCK_DELAY)
    const repo = mockAvailableRepositories.find((candidate) => candidate.fullName === fullName)
    if (!repo) throw new Error("The repository does not exist or this connection cannot see it")
    if (mockRepositoryBindings.some((binding) => binding.fullName === fullName)) {
      throw new Error(`${fullName} is already linked to this workspace`)
    }
    const binding: RepositoryBinding = {
      id: `rep_${crypto.randomUUID()}`,
      connectionId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      htmlUrl: repo.htmlUrl,
      createdAt: new Date().toISOString(),
    }
    mockRepositoryBindings.push(binding)
    return binding
  }

  async unbindRepository(id: string): Promise<void> {
    if (isLiveApi) return live.unbindRepository(id)
    await delay(MOCK_DELAY)
    const index = mockRepositoryBindings.findIndex((binding) => binding.id === id)
    if (index > -1) mockRepositoryBindings.splice(index, 1)
  }

  async getRepositoryBranches(id: string): Promise<RepositoryBranch[]> {
    if (isLiveApi) return live.getRepositoryBranches(id)
    await delay(MOCK_DELAY)
    return [{ name: "main", commitSha: "0000000", protected: true }]
  }

  async getRepositoryPullRequests(id: string): Promise<RepositoryPullRequest[]> {
    if (isLiveApi) return live.getRepositoryPullRequests(id)
    await delay(MOCK_DELAY)
    return []
  }
}

const mockRepositoryBindings: RepositoryBinding[] = []
const mockAvailableRepositories: AvailableRepository[] = [
  { fullName: "demo/website", defaultBranch: "main", private: false, htmlUrl: "https://github.com/demo/website" },
  { fullName: "demo/api", defaultBranch: "main", private: true, htmlUrl: "https://github.com/demo/api" },
]


const apiClient = new ApiClient();

export const api = Object.assign(apiClient, {
  usage: usageService,
  budgets: budgetsService,
  runRetention: runRetentionService,
  costEstimates: costEstimatesService,
  billing: billingService,
  marketplace: marketplaceService,
  seller: sellerService,
  globalSearch: globalSearchService,
  notifications: notificationsService,
  discovery: discoveryService,
  benchmarks: benchmarksService,
  admin: {
    tenants: new AdminTenantsService(),
    users: new AdminUsersService(),
    audit: new AuditService(),
    providers: new ProvidersService(),
    deployments: new DeploymentsService(),
    incidents: new IncidentsService(),
    policies: new PoliciesService(),
    security: new SecurityService(),
    billing: new BillingOpsService(),
    marketplace: new MarketplaceAdminService(),
    featureFlags: new FeatureFlagsService(),
    support: new SupportAccessService()
  }
});

// Demo data: the workspace requires both safeguards, as a new workspace does.
const mockWorkspaceSafeguards = { containsPii: true, approveExternalActions: true }
const mockSafeguardAdditions = new Map<string, WorkflowSafeguards["additions"]>()
let mockTenantDataResidencySettings: TenantDataResidencySettings = {
  tenantId: "ten_mock",
  tenantName: "Demo tenant",
  role: "owner",
  dataResidency: null,
  etag: '"mock-1"',
}

function mockSafeguards(id: string): WorkflowSafeguards {
  const additions = mockSafeguardAdditions.get(id) ?? {
    customerVisible: false,
    containsPii: false,
    approveExternalActions: false,
  }
  return {
    workspace: mockWorkspaceSafeguards,
    additions,
    effective: {
      customerVisible: additions.customerVisible,
      containsPii: mockWorkspaceSafeguards.containsPii || additions.containsPii,
      approveExternalActions:
        mockWorkspaceSafeguards.approveExternalActions || additions.approveExternalActions,
    },
  }
}
