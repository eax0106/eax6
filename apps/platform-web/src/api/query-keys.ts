export const queryKeys = {
  workspace: {
    all: ["workspaces"] as const,
    current: ["workspace", "current"] as const,
    pendingDeletion: ["workspaces", "pending-deletion"] as const,
    runRetention: ["workspace", "run-retention"] as const,
  },
  workflowFolders: ["workflowFolders"] as const,
  workflows: {
    all: ["workflows"] as const,
    detail: (id: string) => ["workflows", id] as const,
    versions: (id: string) => ["workflows", id, "versions"] as const,
    approvalPolicies: (id: string) => ["workflows", id, "approval-policies"] as const,
    safeguards: (id: string) => ["workflows", id, "safeguards"] as const,
    estimate: (id: string) => ["workflows", id, "estimate"] as const,
  },
  projects: {
    all: ["projects"] as const,
    detail: (id: string) => ["projects", id] as const,
    build: (id: string) => ["projects", id, "build"] as const,
    files: (id: string) => ["projects", id, "files"] as const,
    changes: (id: string) => ["projects", id, "changes"] as const,
    tests: (id: string) => ["projects", id, "tests"] as const,
    audit: (id: string) => ["projects", id, "audit"] as const,
    preview: (id: string) => ["projects", id, "preview"] as const,
  },
  runs: {
    all: ["runs"] as const,
    detail: (id: string) => ["runs", id] as const,
  },
  artifacts: {
    all: ["artifacts"] as const,
    byRun: (runId: string) => ["artifacts", "run", runId] as const,
    detail: (id: string) => ["artifacts", id] as const,
  },
  nodeTypes: {
    all: ["nodeTypes"] as const,
  },
  members: {
    all: (workspaceId?: string) => ["members", workspaceId] as const,
  },
  roles: {
    all: (workspaceId?: string) => ["roles", workspaceId] as const,
  },
  permissions: {
    current: (workspaceId?: string) => ["permissions", "current", workspaceId] as const,
  },
  settings: {
    profile: ["settings", "profile"] as const,
    sessions: ["settings", "sessions"] as const,
    language: ["settings", "language"] as const,
    dataResidency: ["settings", "data-residency"] as const,
  },
  repositories: {
    list: ["repositories", "list"] as const,
    available: (connectionId: string) => ["repositories", "available", connectionId] as const,
    branches: (id: string) => ["repositories", id, "branches"] as const,
    pulls: (id: string) => ["repositories", id, "pulls"] as const,
  },
  humanActions: {
    list: (filters?: any) => ["humanActions", "list", filters] as const,
    detail: (id: string) => ["humanActions", "detail", id] as const,
    history: (id: string) => ["humanActions", "history", id] as const,
  },
  recovery: {
    history: (runId: string) => ["recovery", "history", runId] as const,
  },
  workflowHealth: {
    all: ["workflowHealth"] as const,
    detail: (id: string) => ["workflowHealth", "detail", id] as const,
  },
  verifications: {
    node: (runId: string, nodeId: string) => ["verifications", "node", runId, nodeId] as const,
  },
  conversations: {
    list: (filters?: any) => ["conversations", "list", filters] as const,
    detail: (id: string) => ["conversations", "detail", id] as const,
    messages: (id: string) => ["conversations", "messages", id] as const,
  },
  triggers: {
    list: (workflowId: string) => ["triggers", "list", workflowId] as const,
    detail: (id: string) => ["triggers", "detail", id] as const,
  },
  webhooks: {
    list: ["webhooks", "list"] as const,
  },
  events: {
    list: (filters?: any) => ["events", "list", filters] as const,
    detail: (id: string) => ["events", "detail", id] as const,
  },
  dashboard: {
    overview: ["dashboard", "overview"] as const,
  },
  knowledge: {
    sources: {
      list: ["knowledge", "sources", "list"] as const,
      detail: (id: string) => ["knowledge", "sources", "detail", id] as const,
    },
    documents: (sourceId: string) => ["knowledge", "documents", sourceId] as const,
    chunks: (sourceId: string, documentId: string) => ["knowledge", "chunks", sourceId, documentId] as const,
    retrieval: (filters?: any) => ["knowledge", "retrieval", filters] as const,
    memory: ["knowledge", "memory"] as const,
  },
  dataExport: {
    status: ["dataExport", "status"] as const,
    list: (workspaceId: string) => ["dataExport", "list", workspaceId] as const,
    detail: (workspaceId: string, exportId: string) => ["dataExport", "detail", workspaceId, exportId] as const,
  },
  integrations: {
    list: ["integrations", "list"] as const,
    detail: (id: string) => ["integrations", "detail", id] as const,
  },
  connections: {
    list: ["connections", "list"] as const,
    detail: (id: string) => ["connections", "detail", id] as const,
  },
  credentials: {
    list: ["credentials", "list"] as const,
    detail: (id: string) => ["credentials", "detail", id] as const,
  },
  channels: {
    whatsapp: {
      list: ["channels", "whatsapp", "list"] as const,
      detail: (id: string) => ["channels", "whatsapp", "detail", id] as const,
    },
  },

  // Phase 8
  usage: {
    overview: ["usage", "overview"] as const,
    costs: ["usage", "costs"] as const,
    models: ["usage", "models"] as const,
  },
  budgets: {
    list: ["budgets", "list"] as const,
  },
  billing: {
    credits: ["billing", "credits"] as const,
    subscription: ["billing", "subscription"] as const,
    plans: ["billing", "plans"] as const,
    invoices: ["billing", "invoices"] as const,
    paymentMethod: ["billing", "paymentMethod"] as const,
  },
  costEstimate: {
    workflow: (id: string) => ["costEstimate", "workflow", id] as const,
    project: (id: string) => ["costEstimate", "project", id] as const,
  },
  marketplace: {
    listings: (filters?: any) => ["marketplace", "listings", filters] as const,
    detail: (id: string) => ["marketplace", "detail", id] as const,
    myAssets: ["marketplace", "myAssets"] as const,
    reviews: (id: string) => ["marketplace", "reviews", id] as const,
  },
  seller: {
    profile: ["seller", "profile"] as const,
    listings: ["seller", "listings"] as const,
    earnings: ["seller", "earnings"] as const,
    payouts: ["seller", "payouts"] as const,
  },
  globalSearch: (query: string) => ["globalSearch", query] as const,

  // Phase 9
  notifications: {
    list: ["notifications", "list"] as const,
    unreadCount: ["notifications", "unreadCount"] as const,
    preferences: ["notifications", "preferences"] as const,
  },
  discovery: {
    useCases: ["discovery", "useCases"] as const,
    recommendations: ["discovery", "recommendations"] as const,
    suggestions: ["discovery", "suggestions"] as const,
  },
  benchmarks: {
    datasets: ["benchmarks", "datasets"] as const,
    dataset: (id: string) => ["benchmarks", "datasets", id] as const,
    runs: (datasetId?: string) => ["benchmarks", "runs", datasetId ?? "all"] as const,
    run: (id: string) => ["benchmarks", "run", id] as const,
  },
  commands: {
    recent: ["commands", "recent"] as const,
  },

  // Phase 10
  admin: {
    tenants: {
      list: ["admin", "tenants", "list"] as const,
      detail: (id: string) => ["admin", "tenants", "detail", id] as const,
      notes: (id: string) => ["admin", "tenants", "notes", id] as const,
    },
    users: {
      list: ["admin", "users", "list"] as const,
      detail: (id: string) => ["admin", "users", "detail", id] as const,
      notes: (id: string) => ["admin", "users", "notes", id] as const,
    },
    audit: {
      list: (filters?: any) => ["admin", "audit", "list", filters] as const,
    },
    providers: {
      list: ["admin", "providers", "list"] as const,
      detail: (id: string) => ["admin", "providers", "detail", id] as const,
    },
    deployments: {
      list: ["admin", "deployments", "list"] as const,
    },
    incidents: {
      list: ["admin", "incidents", "list"] as const,
      detail: (id: string) => ["admin", "incidents", "detail", id] as const,
    },
    policies: {
      list: ["admin", "policies", "list"] as const,
    },
    security: {
      list: ["admin", "security", "list"] as const,
    },
    billing: {
      issues: ["admin", "billing", "issues"] as const,
    },
    marketplace: {
      reviewQueue: ["admin", "marketplace", "reviewQueue"] as const,
      verifications: ["admin", "marketplace", "verifications"] as const,
    },
    featureFlags: {
      list: ["admin", "featureFlags", "list"] as const,
    },
    support: {
      requests: ["admin", "support", "requests"] as const,
    },
  },
};
