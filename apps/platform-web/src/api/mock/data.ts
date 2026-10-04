import { type Workflow, type Run, type DashboardSummary, type HumanAction, type HumanAnnotation, type RecoveryEvent, type WorkflowHealth } from "../types"

// Simulated latency
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Mock Data
export const mockWorkflows: Workflow[] = [
  {
    id: "wf_01JXYZ123",
    name: "Customer Support Triage",
    description: "Automatically routes incoming support tickets to the correct department.",
    status: "active",
    runs: 1420,
    successRate: 98.5,
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: "wf_01JXYZ124",
    name: "Lead Qualification Pipeline",
    description: "Evaluates and scores leads from web forms.",
    status: "active",
    runs: 843,
    successRate: 94.2,
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
  {
    id: "wf_01JXYZ125",
    name: "Invoice Processing",
    description: "Extracts data from PDF invoices and syncs to accounting.",
    status: "paused",
    runs: 56,
    successRate: 88.0,
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
  {
    id: "wf_01JXYZ126",
    name: "Research Assistant",
    description: "Gathers context on competitors weekly.",
    status: "draft",
    runs: 0,
    successRate: 0,
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
  },
  {
    id: "wf_01JXYZ127",
    name: "Release QA Agent",
    description: "Runs automated checks on staging before deployment.",
    status: "active",
    runs: 231,
    successRate: 99.1,
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
  },
]

export const mockRuns: Run[] = [
  {
    id: "run_01JAX2EF",
    workflowId: "wf_01JXYZ123",
    workflowName: "Customer Support Triage",
    mode: "workflow",
    status: "running",
    startedAt: new Date(Date.now() - 1000 * 15).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 15).toISOString(),
    triggeredBy: { id: "usr_1", name: "Ameen" },
    trigger: { type: "trigger_webhook", name: "Webhook" },
  },
  {
    id: "run_01JAX31D",
    workflowId: "wf_01JXYZ124",
    workflowName: "Lead Qualification Pipeline",
    mode: "workflow",
    status: "completed",
    startedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    completedAt: new Date(Date.now() - 1000 * 60 * 5 + 4200).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    durationMs: 4200,
    triggeredBy: { id: "usr_2", name: "Sarah Chen" },
  },
  {
    id: "run_01JAX48P",
    workflowId: "wf_01JXYZ127",
    workflowName: "Release QA Agent",
    mode: "workflow",
    status: "failed",
    startedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    completedAt: new Date(Date.now() - 1000 * 60 * 30 + 15400).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    durationMs: 15400,
  },
  {
    id: "run_01JAX61M",
    workflowId: "wf_01JXYZ123",
    workflowName: "Customer Support Triage",
    mode: "workflow",
    status: "completed",
    startedAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    completedAt: new Date(Date.now() - 1000 * 60 * 45 + 1800).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    durationMs: 1800,
  },
  {
    id: "run_01JAX77P",
    projectId: "proj_2",
    projectName: "Internal Analytics Dashboard",
    mode: "project",
    status: "running",
    startedAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    triggeredBy: { id: "usr_1", name: "Ameen" },
  },
]

export const mockDashboardSummary: DashboardSummary = {
  activeWorkflows: 12,
  runsToday: 184,
  successRate: 96.4,
  needsAttention: 7,
  recentWorkflows: mockWorkflows.slice(0, 5),
  recentRuns: mockRuns,
}

import { type Workspace, type Member, type Session, type Profile } from "../types"

export const mockWorkspaces: Workspace[] = [
  { id: "ws_1", name: "AlterX", slug: "alterx", role: "admin", tenantOwner: true, memberCount: 4, createdAt: "2024-01-01T00:00:00Z" },
  { id: "ws_2", name: "Acme AI", slug: "acme-ai", role: "admin", memberCount: 12, createdAt: "2024-02-15T00:00:00Z" },
  { id: "ws_3", name: "Personal", slug: "personal", role: "admin", tenantOwner: true, memberCount: 1, createdAt: "2024-03-10T00:00:00Z" },
]

export const mockMembers: Member[] = [
  { id: "usr_1", name: "Ameen", email: "ameen@example.com", role: "admin", tenantOwner: true, status: "active", joinedAt: "2024-01-01T00:00:00Z" },
  { id: "usr_2", name: "Sarah Chen", email: "sarah@acme.ai", role: "admin", status: "active", joinedAt: "2024-01-05T00:00:00Z" },
  { id: "usr_3", name: "Daniel Kim", email: "daniel@acme.ai", role: "editor", status: "active", joinedAt: "2024-02-20T00:00:00Z" },
  { id: "usr_4", name: "Priya Rao", email: "priya@acme.ai", role: "viewer", status: "invited", joinedAt: "2024-03-01T00:00:00Z" },
]

export const mockProfile: Profile = {
  id: "usr_1",
  name: "Ameen",
  email: "ameen@example.com",
  jobTitle: "Founder & CEO",
}

export const mockSessions: Session[] = [
  { id: "sess_1", device: "Windows PC", browser: "Chrome", location: "Bengaluru, India", ip: "103.xxx.xxx.xxx", lastActive: new Date().toISOString(), isCurrent: true },
  { id: "sess_2", device: "iPhone 14 Pro", browser: "Safari", location: "Bengaluru, India", ip: "103.xxx.xxx.xxy", lastActive: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), isCurrent: false },
]

// Phase 3 Mock Data
import { type NodeTypeDefinition, type Project } from "../types"

export const mockNodeTypes: NodeTypeDefinition[] = [
  {
    type: "trigger_manual",
    name: "Manual Trigger",
    description: "Start the workflow manually from the dashboard.",
    category: "Triggers",
    inputs: [],
    outputs: [{ id: "out", name: "Output", type: "any" }],
    configSchema: {}
  },
  {
    type: "trigger_webhook",
    name: "Webhook Trigger",
    description: "Start when a webhook is received.",
    category: "Triggers",
    inputs: [],
    outputs: [{ id: "payload", name: "Payload", type: "object" }],
    configSchema: {
      method: { type: "string", label: "Method", default: "POST" },
      path: { type: "string", label: "Path", default: "/webhook/123" }
    }
  },
  {
    type: "trigger_email",
    name: "Email Trigger",
    description: "Start when an email is received.",
    category: "Triggers",
    inputs: [],
    outputs: [{ id: "email", name: "Email", type: "object" }],
    configSchema: {
      inbox: { type: "string", label: "Inbox Address", default: "support@alterx.ai" }
    }
  },
  {
    type: "ai_llm",
    name: "LLM Prompt",
    description: "Send a prompt to a language model.",
    category: "AI",
    inputs: [{ id: "prompt", name: "Prompt", type: "string" }],
    outputs: [{ id: "response", name: "Response", type: "string" }],
    configSchema: {
      model: { type: "string", label: "Model", default: "gpt-4o" },
      temperature: { type: "number", label: "Temperature", default: 0.7 }
    }
  },
  {
    type: "ai_classify",
    name: "Classify",
    description: "Classify text into predefined categories.",
    category: "AI",
    inputs: [{ id: "text", name: "Text", type: "string" }],
    outputs: [{ id: "category", name: "Category", type: "string" }],
    configSchema: {
      categories: { type: "string", label: "Categories (comma separated)", default: "Urgent, Normal, Spam" }
    }
  },
  {
    type: "ai_extract",
    name: "Extract",
    description: "Extract structured data from unstructured text.",
    category: "AI",
    inputs: [{ id: "text", name: "Text", type: "string" }],
    outputs: [{ id: "data", name: "Data", type: "object" }],
    configSchema: {
      schema: { type: "string", label: "Schema Definition", default: "Name, Email, Phone" }
    }
  },
  {
    type: "logic_condition",
    name: "Condition",
    description: "Route based on a condition.",
    category: "Logic",
    inputs: [{ id: "in", name: "Input", type: "any" }],
    outputs: [
      { id: "true", name: "True", type: "any" },
      { id: "false", name: "False", type: "any" }
    ],
    configSchema: {
      expression: { type: "string", label: "Expression", default: "value == true" }
    }
  },
  {
    type: "action_slack",
    name: "Send Slack Message",
    description: "Send a message to a Slack channel.",
    category: "Actions",
    inputs: [{ id: "message", name: "Message", type: "string" }],
    outputs: [{ id: "result", name: "Result", type: "object" }],
    configSchema: {
      connection: { type: "string", label: "Connection", default: "Acme Workspace" },
      channel: { type: "string", label: "Channel", default: "#alerts" }
    }
  },
  {
    type: "action_http",
    name: "HTTP Request",
    description: "Make an HTTP request.",
    category: "Actions",
    inputs: [{ id: "body", name: "Body", type: "any" }],
    outputs: [{ id: "response", name: "Response", type: "object" }],
    configSchema: {
      url: { type: "string", label: "URL", default: "https://api.example.com" },
      method: { type: "string", label: "Method", default: "GET" }
    }
  }
]

export const mockProjects: Project[] = [
  {
    id: "proj_1",
    name: "Customer Support Portal",
    status: "draft",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    brief: {
      goal: "Create a self-service support portal for customers.",
      primaryUsers: "SaaS customers",
      coreCapabilities: ["Search documentation", "Submit tickets", "View ticket status", "AI support assistant"]
    }
  },
  {
    id: "proj_2",
    name: "Internal Analytics Dashboard",
    status: "ready",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString(),
    brief: {
      goal: "Provide unified analytics for the executive team.",
      primaryUsers: "Executives, Managers",
      coreCapabilities: ["Sales overview", "User growth", "Revenue forecasting"]
    },
    plan: {
      phases: [
        {
          id: "ph_1",
          title: "Foundation",
          tasks: [
            { id: "t_1", title: "Setup database connections", status: "done" },
            { id: "t_2", title: "Configure authentication", status: "done" }
          ]
        },
        {
          id: "ph_2",
          title: "Dashboard UI",
          tasks: [
            { id: "t_3", title: "Build layout and navigation", status: "in_progress" },
            { id: "t_4", title: "Implement charts", status: "pending" }
          ]
        }
      ]
    }
  }
]

import { type Artifact } from "../types"

export const mockArtifacts: Artifact[] = [
  {
    id: "art_1",
    runId: "run_01JAX31D",
    name: "support-analysis.json",
    type: "json",
    sizeBytes: 1024 * 12,
    createdAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  },
  {
    id: "art_2",
    runId: "run_01JAX61M",
    name: "execution-report.md",
    type: "report",
    sizeBytes: 1024 * 45,
    createdAt: new Date(Date.now() - 1000 * 60 * 44).toISOString(),
  },
  {
    id: "art_3",
    runId: "run_01JAX2EF",
    name: "customer-list.csv",
    type: "file",
    mimeType: "text/csv",
    sizeBytes: 1024 * 1024 * 2.5,
    createdAt: new Date(Date.now() - 1000 * 5).toISOString(),
  },
  {
    id: "art_4",
    runId: "run_01JAX77P",
    name: "build.zip",
    type: "archive",
    mimeType: "application/zip",
    sizeBytes: 1024 * 1024 * 15,
    createdAt: new Date(Date.now() - 1000 * 60).toISOString(),
  }
]

export const mockHumanActions: HumanAction[] = [
  {
    id: "ha_01JAX92D",
    type: "approval",
    approvalNodeKey: "approval",
    approvalMode: "ask",
    approvalStatus: "pending",
    status: "open",
    priority: "high",
    title: "Refund approval required",
    description: "Refund exceeds automatic approval threshold.",
    workspaceId: "ws_1",
    runId: "run_01JAX2EF",
    workflowId: "wf_01JXYZ123",
    workflowName: "Customer Support Triage",
    nodeId: "node_refund",
    nodeName: "Refund Approval",
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    context: {
      summary: "Customer Acme Corp requested a refund of $8,400.",
      reason: "Above auto-approval threshold",
      recommendation: "Approve",
      confidence: 0.92,
      risk: "High financial impact",
    },
  },
  {
    id: "ha_01JAX93F",
    type: "clarification",
    status: "open",
    priority: "normal",
    title: "Choose accounting destination",
    description: "AlterX needs to know which account should receive this invoice.",
    workspaceId: "ws_1",
    runId: "run_01JAX31D",
    workflowId: "wf_01JXYZ125",
    workflowName: "Invoice Processing",
    nodeId: "node_route",
    nodeName: "Route Invoice",
    createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    dueAt: new Date(Date.now() + 1000 * 60 * 15).toISOString(),
    context: {
      summary: "Invoice #9822 for Software Subscriptions ($120.00)",
      options: [
        { id: "opt_1", label: "Operations" },
        { id: "opt_2", label: "Marketing" },
        { id: "opt_3", label: "Engineering" },
      ]
    },
  },
  {
    id: "ha_01JAX94G",
    type: "escalation",
    status: "claimed",
    priority: "high",
    title: "Conflicting customer identities",
    description: "The agent encountered conflicting customer records and cannot determine which identity is correct.",
    workspaceId: "ws_1",
    runId: "run_01JAX61M",
    workflowId: "wf_01JXYZ123",
    workflowName: "Customer Support Triage",
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    claimedBy: { id: "usr_1", name: "Ameen" },
    claimedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    context: {
      recommendation: "Review both records and choose the canonical customer.",
    }
  },
  {
    id: "ha_01JAX95H",
    type: "approval",
    approvalNodeKey: "approval",
    approvalMode: "ask",
    approvalStatus: "approved",
    status: "resolved",
    priority: "critical",
    title: "Production deployment blocked",
    description: "QA checks passed but deployment requires manual sign-off.",
    workspaceId: "ws_1",
    runId: "run_01JAX48P",
    workflowId: "wf_01JXYZ127",
    workflowName: "Release QA Agent",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    resolvedBy: { id: "usr_2", name: "Sarah Chen" },
    resolvedAt: new Date(Date.now() - 1000 * 60 * 60 * 23).toISOString(),
    resolution: "approved",
  },
  {
    id: "ha_01JAX96J",
    type: "clarification",
    status: "expired",
    priority: "normal",
    title: "Dependency version decision",
    description: "The build found incompatible package versions.",
    workspaceId: "ws_1",
    runId: "run_01JAX77P",
    projectId: "proj_01JABC123",
    projectName: "Customer Portal",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    dueAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  }
]

export const mockHumanAnnotations: HumanAnnotation[] = [
  {
    id: "ann_1",
    actionId: "ha_01JAX94G",
    author: { id: "usr_1", name: "Ameen" },
    text: "I am checking Zendesk to see which email they used last.",
    createdAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  }
]

export const mockRecoveryEvents: RecoveryEvent[] = [
  {
    id: "rec_1",
    runId: "run_01JAX61M",
    nodeId: "node_refund",
    type: "human_decision",
    actor: { id: "usr_1", name: "Ameen" },
    summary: "Ameen approved refund escalation. Run resumed.",
    createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    id: "rec_2",
    runId: "run_01JAX61M",
    nodeId: "node_refund",
    type: "abort",
    actor: { type: "system", name: "AlterX" },
    summary: "AlterX paused execution. Approval required.",
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  }
]

export const mockWorkflowHealth: WorkflowHealth[] = [
  {
    workflowId: "wf_01JXYZ123",
    overallScore: 94,
    status: "healthy",
    dimensions: {
      validation: { score: 98, status: "healthy", summary: "Inputs are well formed" },
      availability: { score: 99, status: "healthy", summary: "Uptime is great" },
      correctness: { score: 90, status: "healthy", summary: "Most outputs verified" },
      reliability: { score: 89, status: "warning", summary: "Some nodes retried often", issues: [{ id: "i1", message: "API timeouts" }] }
    },
    recentFailures: 2,
    degradedRuns: 5,
    lastEvaluatedAt: new Date().toISOString(),
  },
  {
    workflowId: "wf_01JXYZ124",
    overallScore: 81,
    status: "warning",
    dimensions: {
      validation: { score: 85, status: "warning", summary: "Some unexpected inputs" },
      availability: { score: 95, status: "healthy", summary: "Service stable" },
      correctness: { score: 78, status: "warning", summary: "Outputs vary slightly" },
      reliability: { score: 82, status: "warning", summary: "Occasional failures" }
    },
    recentFailures: 12,
    degradedRuns: 20,
    lastEvaluatedAt: new Date().toISOString(),
  },
  {
    workflowId: "wf_01JXYZ125",
    overallScore: 67,
    status: "critical",
    dimensions: {
      validation: { score: 60, status: "critical", summary: "Many schema violations" },
      availability: { score: 90, status: "healthy", summary: "Service available" },
      correctness: { score: 65, status: "critical", summary: "Frequent manual overrides" },
      reliability: { score: 70, status: "warning", summary: "Error rates elevated" }
    },
    recentFailures: 45,
    degradedRuns: 8,
    lastEvaluatedAt: new Date().toISOString(),
  }
]

// Phase 6 Mock Data

import { type Conversation, type ConversationMessage, type Trigger, type WebhookEndpoint, type IncomingEvent, type DashboardOverview } from "../types"

export const mockConversations: Conversation[] = [
  {
    id: "conv_01",
    title: "Customer Support Automation",
    type: "workflow_builder",
    status: "active",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
    createdBy: { id: "usr_1", name: "Ameen" },
    linkedWorkflowId: "wf_01JXYZ123",
    preview: "Created triage workflow and added approval step.",
  },
  {
    id: "conv_02",
    title: "Customer Portal",
    type: "project_builder",
    status: "active",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    createdBy: { id: "usr_1", name: "Ameen" },
    linkedProjectId: "proj_1",
    preview: "Drafted project brief.",
  },
  {
    id: "conv_03",
    title: "Invoice Processing failure",
    type: "run_investigation",
    status: "active",
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    createdBy: { id: "usr_2", name: "Sarah Chen" },
    linkedRunId: "run_01JAX31D",
    preview: "Investigating why the OCR node failed.",
  },
]

export const mockConversationMessages: Record<string, ConversationMessage[]> = {
  "conv_03": [
    {
      id: "msg_01",
      conversationId: "conv_03",
      role: "user",
      kind: "text",
      createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
      content: "Why did this run fail?"
    },
    {
      id: "msg_02",
      conversationId: "conv_03",
      role: "assistant",
      kind: "run",
      createdAt: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
      content: {
        summary: "The run failed at OCR Extraction.",
        reason: "The uploaded invoice PDF was corrupted or unreadable.",
        attempts: 1,
        recommendation: "Upload a valid PDF and retry the failed node."
      }
    }
  ]
}

export const mockTriggers: Trigger[] = [
  {
    id: "trg_01",
    workflowId: "wf_01JXYZ123",
    type: "webhook",
    name: "Stripe Webhook",
    enabled: true,
    status: "configured",
    config: { method: "POST", path: "/hooks/stripe" },
    lastTriggeredAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    lastTestedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
  {
    id: "trg_02",
    workflowId: "wf_01JXYZ123",
    type: "schedule",
    name: "Daily Sync",
    enabled: false,
    status: "needs_configuration",
    config: {},
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
]

export const mockWebhooks: WebhookEndpoint[] = [
  {
    id: "wh_01",
    name: "Stripe Webhook",
    workflowId: "wf_01JXYZ123",
    triggerId: "trg_01",
    path: "/hooks/stripe",
    url: "https://api.alterx.mock/hooks/wh_01JXYZ",
    method: "POST",
    enabled: true,
    authentication: "secret",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    lastReceivedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
  }
]

export const mockEvents: IncomingEvent[] = [
  {
    id: "evt_01",
    source: "webhook",
    type: "customer.created",
    status: "triggered",
    workflowId: "wf_01JXYZ123",
    triggerId: "trg_01",
    runId: "run_01JAX2EF",
    receivedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
  },
  {
    id: "evt_02",
    source: "email",
    type: "support.email.received",
    status: "failed",
    receivedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    error: {
      code: "EVENT_SIGNATURE_INVALID",
      message: "Signature verification failed."
    }
  },
  {
    id: "evt_03",
    source: "integration",
    type: "github.issue.closed",
    status: "ignored",
    receivedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  }
]

export const mockDashboardOverview: DashboardOverview = {
  metrics: { activeWorkflows: 12, runsToday: 184, successRate: 96.4, needsAttention: 7 },
  liveRuns: mockRuns.filter(r => r.status === "running" || r.status === "waiting"),
  humanActions: { total: 5, approvals: 2, clarifications: 2, escalations: 1 },
  health: { healthy: 1, warning: 1, critical: 1 },
  triggerSummary: { enabled: 1, needsConfiguration: 1, failing: 0 },
  recentEvents: mockEvents,
  projectBuilds: mockRuns.filter(r => r.mode === "project"),
}

// Phase 7 Mock Data

import type { 
  KnowledgeSource, 
  KnowledgeDocument, 
  KnowledgeChunk,
  IntegrationDefinition,
  Connection,
  Credential,
  WhatsAppChannel,
  MemoryConfiguration
} from "../types"

export const mockKnowledgeSources: KnowledgeSource[] = [
  {
    id: "ks_01",
    name: "Product Documentation",
    type: "website",
    status: "ready",
    documentCount: 42,
    chunkCount: 840,
    lastSyncedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
  {
    id: "ks_02",
    name: "Support Policies",
    type: "file_upload",
    status: "ready",
    documentCount: 5,
    chunkCount: 120,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
  {
    id: "ks_03",
    name: "Internal Wiki",
    type: "notion",
    status: "syncing",
    documentCount: 150,
    chunkCount: 3000,
    lastSyncedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    updatedAt: new Date().toISOString(),
    connectionId: "conn_02"
  },
  {
    id: "ks_04",
    name: "Legacy FAQ",
    type: "file_upload",
    status: "failed",
    documentCount: 1,
    chunkCount: 0,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  }
]

export const mockKnowledgeDocuments: KnowledgeDocument[] = [
  {
    id: "doc_01",
    sourceId: "ks_02",
    name: "refund-policy.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024 * 1024 * 2.5, // 2.5MB
    status: "indexed",
    chunkCount: 42,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    indexedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
  {
    id: "doc_02",
    sourceId: "ks_02",
    name: "product-guide.md",
    mimeType: "text/markdown",
    sizeBytes: 1024 * 45, // 45KB
    status: "indexed",
    chunkCount: 31,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    indexedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
  {
    id: "doc_03",
    sourceId: "ks_04",
    name: "old-faq.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024 * 1024 * 15,
    status: "failed",
    error: { code: "UNSUPPORTED_FORMAT", message: "Document contains unextractable image text without OCR." },
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
]

export const mockKnowledgeChunks: KnowledgeChunk[] = [
  {
    id: "chunk_018",
    sourceId: "ks_02",
    documentId: "doc_01",
    index: 18,
    contentPreview: "Annual subscriptions may receive a prorated refund if cancelled within the first 30 days of the billing cycle. After 30 days, no refunds will be issued for annual plans.",
    tokenCount: 45,
    embeddingStatus: "indexed",
  },
  {
    id: "chunk_019",
    sourceId: "ks_02",
    documentId: "doc_01",
    index: 19,
    contentPreview: "Monthly subscriptions are non-refundable. If you cancel a monthly subscription, you will retain access to the platform until the end of your current billing period.",
    tokenCount: 38,
    embeddingStatus: "indexed",
  }
]

export const mockMemoryConfig: MemoryConfiguration = {
  conversationMemoryEnabled: true,
  workflowMemoryEnabled: true,
  workspaceMemoryEnabled: true,
  retentionDays: 90,
  etag: '"memory-0"',
}

export const mockIntegrationDefinitions: IntegrationDefinition[] = [
  {
    id: "int_slack",
    name: "Slack",
    category: "Communication",
    description: "Send messages, read channels, and interact with users in Slack.",
    capabilities: ["Send messages", "Read messages", "Manage channels"],
    authType: "oauth",
    available: true,
  },
  {
    id: "int_gmail",
    name: "Gmail",
    category: "Communication",
    description: "Send and receive emails from your Workspace.",
    capabilities: ["Send emails", "Read inbox", "Manage drafts"],
    authType: "oauth",
    available: true,
  },
  {
    id: "int_github",
    name: "GitHub",
    category: "Development",
    description: "Manage repositories, issues, and pull requests.",
    capabilities: ["Read code", "Manage issues", "Create PRs"],
    authType: "oauth",
    available: true,
  },
  {
    id: "int_postgres",
    name: "PostgreSQL",
    category: "Data",
    description: "Connect directly to a PostgreSQL database.",
    capabilities: ["Execute queries", "Read schema"],
    authType: "credentials",
    available: true,
  },
  {
    id: "int_openai",
    name: "OpenAI",
    category: "AI",
    description: "Use OpenAI models for completion and analysis.",
    capabilities: ["Chat completion", "Embeddings"],
    authType: "api_key",
    available: true,
  },
  {
    id: "int_notion",
    name: "Notion",
    category: "Productivity",
    description: "Read and write to Notion databases and pages.",
    capabilities: ["Read pages", "Write blocks"],
    authType: "oauth",
    available: true,
  }
]

export const mockCredentials: Credential[] = [
  {
    id: "cred_01",
    name: "Slack OAuth — Acme",
    type: "oauth",
    provider: "Slack",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    lastUsedAt: new Date().toISOString(),
    usedByConnectionIds: ["conn_01"]
  },
  {
    id: "cred_02",
    name: "OpenAI Production",
    type: "api_key",
    provider: "OpenAI",
    maskedValue: "sk_••••••••7Q2M",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    lastUsedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    usedByConnectionIds: ["conn_04"]
  },
  {
    id: "cred_03",
    name: "Notion Internal",
    type: "oauth",
    provider: "Notion",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    usedByConnectionIds: ["conn_02"]
  }
]

export const mockConnections: Connection[] = [
  {
    id: "conn_01",
    integrationId: "int_slack",
    name: "Acme Engineering Slack",
    status: "connected",
    credentialId: "cred_01",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    id: "conn_02",
    integrationId: "int_notion",
    name: "Acme Corp Notion",
    status: "connected",
    credentialId: "cred_03",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
  },
  {
    id: "conn_03",
    integrationId: "int_gmail",
    name: "Support Shared Inbox",
    status: "expired",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
  {
    id: "conn_04",
    integrationId: "int_openai",
    name: "OpenAI Prod Link",
    status: "connected",
    credentialId: "cred_02",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  }
]

export const mockWhatsAppChannels: WhatsAppChannel[] = [
  {
    id: "wa_01",
    name: "Customer Support WA",
    phoneNumber: "+1 (555) 123-4567",
    status: "connected",
    provider: "meta",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15).toISOString(),
  }
]
