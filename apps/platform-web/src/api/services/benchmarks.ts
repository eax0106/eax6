import { apiGet, apiPost, isLiveApi, mutationKey } from "../http"
import { delay } from "../mock/data"

// D25 (b): a workspace's benchmark datasets (test cases: an input plus the
// success criteria it should meet) and runs of a workflow against a dataset.
// Runs execute through Simulate, so no outside action fires.

export interface BenchmarkCase {
  id: string
  position: number
  input: Record<string, unknown>
  successCriteria: string[]
}

export interface BenchmarkDataset {
  id: string
  name: string
  description: string
  caseCount: number
  createdBy: string
  createdAt: string
}

export interface BenchmarkDatasetDetail extends BenchmarkDataset {
  cases: BenchmarkCase[]
}

export type BenchmarkRunStatus = "pending" | "running" | "completed" | "failed"

export interface BenchmarkRun {
  id: string
  datasetId: string
  workflowId: string
  workflowVersionId: string | null
  status: BenchmarkRunStatus
  caseCount: number
  passed: number
  failed: number
  errored: number
  passRate: number | null
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number | null
  error: string | null
  requestedBy: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface BenchmarkRunStep {
  key: string
  type: string
  status: "executed" | "simulated" | "skipped" | "failed"
  action?: string
  verdict?: string
  error?: string
}

export interface BenchmarkCaseOutcome {
  caseId: string
  position: number
  verdict: "pass" | "fail" | "error"
  score: number | null
  threshold: number | null
  reviewerModel: string | null
  output: unknown
  steps: BenchmarkRunStep[]
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number | null
  durationMs: number
  error: string | null
}

export interface BenchmarkRunDetail extends BenchmarkRun {
  results: BenchmarkCaseOutcome[]
}

export interface NewBenchmarkDataset {
  name: string
  description: string
  cases: { input: Record<string, unknown>; successCriteria: string[] }[]
}

// Demo mode: an in-memory workspace. Demo mode has no engine, so a demo run
// records each case as not run rather than inventing a verdict.
const demoDatasets: BenchmarkDatasetDetail[] = []
const demoRuns: BenchmarkRunDetail[] = []

function demoId() {
  return crypto.randomUUID()
}

export const benchmarksService = {
  async listDatasets(): Promise<BenchmarkDataset[]> {
    if (isLiveApi) return (await apiGet<{ data: BenchmarkDataset[] }>("/api/v1/benchmarks/datasets")).data
    await delay(200)
    return demoDatasets.map(({ cases: _cases, ...dataset }) => dataset)
  },

  async getDataset(id: string): Promise<BenchmarkDatasetDetail> {
    if (isLiveApi) return apiGet<BenchmarkDatasetDetail>(`/api/v1/benchmarks/datasets/${encodeURIComponent(id)}`)
    await delay(150)
    const dataset = demoDatasets.find(item => item.id === id)
    if (!dataset) throw new Error("Benchmark dataset not found")
    return dataset
  },

  async createDataset(input: NewBenchmarkDataset): Promise<BenchmarkDatasetDetail> {
    if (isLiveApi) {
      return apiPost<BenchmarkDatasetDetail>("/api/v1/benchmarks/datasets", input, { idempotencyKey: mutationKey("benchmark-dataset") })
    }
    await delay(300)
    if (demoDatasets.some(item => item.name === input.name.trim())) throw new Error("A dataset with this name already exists")
    const dataset: BenchmarkDatasetDetail = {
      id: demoId(),
      name: input.name.trim(),
      description: input.description.trim(),
      caseCount: input.cases.length,
      createdBy: "demo-user",
      createdAt: new Date().toISOString(),
      cases: input.cases.map((item, position) => ({ id: demoId(), position, ...item })),
    }
    demoDatasets.unshift(dataset)
    return dataset
  },

  async startRun(datasetId: string, workflowId: string): Promise<BenchmarkRunDetail> {
    if (isLiveApi) {
      return apiPost<BenchmarkRunDetail>(`/api/v1/benchmarks/datasets/${encodeURIComponent(datasetId)}/runs`, { workflowId },
        { idempotencyKey: mutationKey("benchmark-run") })
    }
    await delay(400)
    const dataset = await this.getDataset(datasetId)
    const now = new Date().toISOString()
    const run: BenchmarkRunDetail = {
      id: demoId(), datasetId, workflowId, workflowVersionId: null, status: "completed", caseCount: dataset.caseCount,
      passed: 0, failed: 0, errored: dataset.caseCount, passRate: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null,
      error: null, requestedBy: "demo-user", createdAt: now, startedAt: now, completedAt: now,
      results: dataset.cases.map(item => ({
        caseId: item.id, position: item.position, verdict: "error", score: null, threshold: null, reviewerModel: null,
        output: {}, steps: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: null, durationMs: 0,
        error: "Demo mode does not run workflows",
      })),
    }
    demoRuns.unshift(run)
    return run
  },

  async listRuns(datasetId?: string): Promise<BenchmarkRun[]> {
    if (isLiveApi) {
      const query = new URLSearchParams({ limit: "50", ...(datasetId ? { datasetId } : {}) })
      return (await apiGet<{ data: BenchmarkRun[] }>(`/api/v1/benchmarks/runs?${query}`)).data
    }
    await delay(150)
    return demoRuns.filter(run => !datasetId || run.datasetId === datasetId).map(({ results: _results, ...run }) => run)
  },

  async getRun(id: string): Promise<BenchmarkRunDetail> {
    if (isLiveApi) return apiGet<BenchmarkRunDetail>(`/api/v1/benchmarks/runs/${encodeURIComponent(id)}`)
    await delay(150)
    const run = demoRuns.find(item => item.id === id)
    if (!run) throw new Error("Benchmark run not found")
    return run
  },
}
