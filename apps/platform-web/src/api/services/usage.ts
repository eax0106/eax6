import { type UsageSummary, type CostRecord, type ModelUsage, type Budget } from "../types"
import { isLiveApi } from "../http"
import * as liveBudgets from "../live-budgets"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mockUsageSummary: UsageSummary = {
  periodStart: new Date(new Date().setDate(1)).toISOString(), // 1st of current month
  periodEnd: new Date().toISOString(),
  totalCost: 284.73,
  runs: 1542,
  inputTokens: 14200000,
  outputTokens: 1910000,
  computeSeconds: 8400,
  storageBytes: 15 * 1024 * 1024 * 1024,
  workflowCount: 12,
  projectCount: 3,
}

const mockModelUsage: ModelUsage[] = [
  { provider: "OpenAI", model: "gpt-4o", inputTokens: 8400000, outputTokens: 1100000, cost: 142.80, runCount: 950 },
  { provider: "Anthropic", model: "claude-3-5-sonnet", inputTokens: 3200000, outputTokens: 430000, cost: 62.15, runCount: 320 },
  { provider: "Google", model: "gemini-1.5-pro", inputTokens: 2100000, outputTokens: 380000, cost: 31.90, runCount: 150 },
]

let mockBudgets: Budget[] = [
  {
    id: "budg_1",
    name: "Workspace Monthly",
    scope: "workspace",
    amount: 500,
    currency: "USD",
    period: "monthly",
    currentSpend: 284.73,
    enabled: true,
    thresholds: [
      { percent: 50, action: "notify" },
      { percent: 80, action: "warn" },
      { percent: 100, action: "block" }
    ]
  },
  {
    id: "budg_2",
    name: "Customer Support Automation",
    scope: "workflow",
    scopeId: "wf_1",
    amount: 100,
    currency: "USD",
    period: "monthly",
    currentSpend: 81.44,
    enabled: true,
    thresholds: [
      { percent: 80, action: "warn" }
    ]
  }
]

export const usageService = {
  getOverview: async (): Promise<UsageSummary> => {
    await delay(300)
    return mockUsageSummary
  },
  getCosts: async (): Promise<CostRecord[]> => {
    await delay(400)
    return [] // Could return a list of recent cost records if needed
  },
  getModelUsage: async (): Promise<ModelUsage[]> => {
    await delay(300)
    return mockModelUsage
  },
  getWorkflowUsage: async (): Promise<any[]> => {
    await delay(300)
    return [
      { id: "wf_1", name: "Customer Support Triage", runs: 1284, cost: 81.44, avgCost: 81.44/1284, tokens: 4500000, updatedAt: new Date().toISOString() },
      { id: "wf_2", name: "Research Assistant", runs: 221, cost: 103.21, avgCost: 103.21/221, tokens: 6800000, updatedAt: new Date().toISOString() },
    ]
  },
  getProjectUsage: async (): Promise<any[]> => {
    await delay(300)
    return [
      { id: "proj_1", name: "Competitor Analysis", buildRuns: 14, cost: 42.50, computeCost: 12.00, modelCost: 28.50, storageCost: 2.00 },
      { id: "proj_2", name: "Onboarding Portal", buildRuns: 5, cost: 14.20, computeCost: 4.20, modelCost: 8.00, storageCost: 2.00 },
    ]
  }
}

export const budgetsService = {
  list: async (): Promise<Budget[]> => {
    if (isLiveApi) return liveBudgets.listBudgets()
    await delay(300)
    return mockBudgets
  },
  create: async (data: Partial<Budget>): Promise<Budget> => {
    if (isLiveApi) return liveBudgets.createBudget(data)
    await delay(400)
    const budget = { ...mockBudgets[0], ...data, id: "budg_" + Date.now(), scope: "workspace", period: "monthly", currentSpend: 0 } as Budget
    mockBudgets = [...mockBudgets, budget]
    return budget
  },
  update: async (_id: string, data: Partial<Budget>): Promise<Budget> => {
    if (isLiveApi) return liveBudgets.updateBudget(_id, data)
    await delay(400)
    mockBudgets = mockBudgets.map(b => (b.id === _id ? { ...b, ...data } : b))
    return mockBudgets.find(b => b.id === _id)!
  },
  remove: async (_id: string): Promise<void> => {
    if (isLiveApi) return liveBudgets.deleteBudget(_id)
    await delay(300)
    mockBudgets = mockBudgets.filter(b => b.id !== _id)
  }
}

export const costEstimatesService = {
  // Live mode (B2.9): no estimate is shown until one can be derived from the
  // workflow's own plan -- the cost ledger estimates only explicit line items.
  forWorkflow: async (_id: string) => {
    if (isLiveApi) return null
    await delay(400)
    return {
      currency: "USD",
      low: 0.08,
      expected: 0.11,
      high: 0.14,
      breakdown: [
        { name: "Model", amount: 0.07 },
        { name: "Compute", amount: 0.03 },
        { name: "Connections", amount: 0.01 },
      ],
      assumptions: ["Assumes ~1,500 input tokens per run", "Assumes standard RAG latency"]
    }
  },
  forProject: async (_id: string) => {
    if (isLiveApi) return null
    await delay(500)
    return {
      currency: "USD",
      low: 4.20,
      expected: 6.00,
      high: 7.80,
      breakdown: [
        { name: "Model", amount: 4.50 },
        { name: "Compute", amount: 1.00 },
        { name: "Test execution", amount: 0.40 },
        { name: "Storage", amount: 0.10 }
      ],
      assumptions: ["Assumes 3 iterative build cycles", "Assumes GPT-4 class models for planning"]
    }
  }
}
