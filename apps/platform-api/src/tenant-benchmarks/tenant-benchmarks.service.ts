import { Injectable } from "@nestjs/common";
import { TenantIdSchema, WorkflowIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import { z } from "zod";

import type { ActorContextType } from "../rbac";
import { PlatformHttpError } from "../signup/problem";

const BASE = "/api/v1/benchmarks";
export const BENCHMARK_READERS = ["admin", "editor", "operator", "approver", "viewer"] as const;
export const BENCHMARK_WRITERS = ["admin", "editor"] as const;

const Uuid = z.uuid();
const Criteria = z.array(z.string().trim().min(1).max(1000)).min(1).max(20);
const CreateDatasetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  cases: z.array(z.object({ input: z.record(z.string(), z.unknown()), successCriteria: Criteria }).strict()).min(1).max(100),
}).strict();
const StartRunSchema = z.object({ workflowId: WorkflowIdSchema }).strict();
const ListRunsSchema = z.object({
  datasetId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const Iso = z.iso.datetime({ offset: true });
const DatasetSchema = z.object({
  id: Uuid, name: z.string(), description: z.string(), caseCount: z.number().int(), createdBy: z.string(), createdAt: Iso,
});
const DatasetDetailSchema = DatasetSchema.extend({
  cases: z.array(z.object({ id: Uuid, position: z.number().int(), input: z.record(z.string(), z.unknown()), successCriteria: z.array(z.string()) })),
});
const RunSchema = z.object({
  id: Uuid, datasetId: Uuid, workflowId: z.string(), workflowVersionId: z.string().nullable(),
  status: z.enum(["pending", "running", "completed", "failed"]), caseCount: z.number().int(),
  passed: z.number().int(), failed: z.number().int(), errored: z.number().int(), passRate: z.number().min(0).max(1).nullable(),
  inputTokens: z.number().int(), outputTokens: z.number().int(), estimatedCostUsd: z.number().nullable(),
  error: z.string().nullable(), requestedBy: z.string(), createdAt: Iso, startedAt: Iso.nullable(), completedAt: Iso.nullable(),
});
const RunDetailSchema = RunSchema.extend({
  results: z.array(z.object({
    caseId: Uuid, position: z.number().int(), verdict: z.enum(["pass", "fail", "error"]), score: z.number().nullable(),
    threshold: z.number().nullable(), reviewerModel: z.string().nullable(), output: z.unknown(), steps: z.array(z.unknown()),
    inputTokens: z.number().int(), outputTokens: z.number().int(), estimatedCostUsd: z.number().nullable(),
    durationMs: z.number().int(), error: z.string().nullable(),
  })),
});

export interface TenantBenchmarksConfig { readonly baseUrl: string; readonly tokenRef: string; readonly timeoutMs: number }

interface Scope { readonly tenant_id: string; readonly workspace_id: string; readonly user: string }

/**
 * D25 (b): a workspace's benchmark datasets and runs, held by eval-service.
 * @driver call serves every /api/v1/benchmarks route; its deadline cancels the upstream request.
 */
@Injectable()
export class TenantBenchmarksService {
  constructor(private readonly config: TenantBenchmarksConfig,
    private readonly resolveSecret: (reference: string) => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async listDatasets(actor: ActorContextType | undefined) {
    const scope = this.scope(actor, false);
    const body = await this.call("GET", "/datasets", scope, `${BASE}/datasets`);
    return { data: z.array(DatasetSchema).max(200).parse((body as { data?: unknown }).data) };
  }

  async createDataset(actor: ActorContextType | undefined, input: unknown) {
    const scope = this.scope(actor, true);
    const parsed = parse(CreateDatasetSchema, input, `${BASE}/datasets`);
    const body = await this.call("POST", "/datasets", scope, `${BASE}/datasets`, {
      name: parsed.name, description: parsed.description, created_by: scope.user,
      cases: parsed.cases.map((item) => ({ input: item.input, success_criteria: item.successCriteria })),
    });
    return DatasetDetailSchema.parse(body);
  }

  async getDataset(actor: ActorContextType | undefined, datasetId: string) {
    const scope = this.scope(actor, false);
    const id = parse(Uuid, datasetId, `${BASE}/datasets`);
    return DatasetDetailSchema.parse(await this.call("GET", `/datasets/${id}`, scope, `${BASE}/datasets/${id}`));
  }

  async startRun(actor: ActorContextType | undefined, datasetId: string, input: unknown) {
    const scope = this.scope(actor, true);
    const id = parse(Uuid, datasetId, `${BASE}/datasets`);
    const instance = `${BASE}/datasets/${id}/runs`;
    const parsed = parse(StartRunSchema, input, instance);
    const body = await this.call("POST", `/datasets/${id}/runs`, scope, instance, { workflow_id: parsed.workflowId, requested_by: scope.user });
    return RunDetailSchema.parse(body);
  }

  async listRuns(actor: ActorContextType | undefined, query: unknown) {
    const scope = this.scope(actor, false);
    const parsed = parse(ListRunsSchema, query, `${BASE}/runs`);
    const params = new URLSearchParams({ limit: String(parsed.limit), ...(parsed.datasetId ? { dataset_id: parsed.datasetId } : {}) });
    const body = await this.call("GET", `/runs?${params}`, scope, `${BASE}/runs`);
    return { data: z.array(RunSchema).max(100).parse((body as { data?: unknown }).data) };
  }

  async getRun(actor: ActorContextType | undefined, runId: string) {
    const scope = this.scope(actor, false);
    const id = parse(Uuid, runId, `${BASE}/runs`);
    return RunDetailSchema.parse(await this.call("GET", `/runs/${id}`, scope, `${BASE}/runs/${id}`));
  }

  private scope(actor: ActorContextType | undefined, write: boolean): Scope {
    if (!actor) throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", BASE);
    const tenant = TenantIdSchema.safeParse(actor.tenant_id.startsWith("ten_") ? actor.tenant_id : `ten_${actor.tenant_id}`);
    const workspace = WorkspaceIdSchema.safeParse(actor.workspace_id?.startsWith("ws_") ? actor.workspace_id : `ws_${actor.workspace_id ?? ""}`);
    if (!tenant.success || !workspace.success) throw new PlatformHttpError(403, "BENCHMARK_WORKSPACE_REQUIRED", "Valid workspace context required", BASE);
    const binding = actor.workspaceRoles?.find((row) => (row.workspaceId.startsWith("ws_") ? row.workspaceId : `ws_${row.workspaceId}`) === workspace.data);
    const allowed: readonly string[] = write ? BENCHMARK_WRITERS : BENCHMARK_READERS;
    if (!binding || !allowed.includes(binding.role)) throw new PlatformHttpError(403, "BENCHMARK_ROLE_DENIED", "Workspace role required", BASE);
    return { tenant_id: tenant.data, workspace_id: workspace.data, user: actor.user_id };
  }

  private async call(method: "GET" | "POST", path: string, scope: Scope, instance: string, body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const scoped = { tenant_id: scope.tenant_id, workspace_id: scope.workspace_id };
    try {
      const token = await this.resolveSecret(this.config.tokenRef);
      if (!token) throw new Error("Missing benchmark service credential");
      const url = method === "GET"
        ? `${this.config.baseUrl}/internal/benchmarks${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(scoped)}`
        : `${this.config.baseUrl}/internal/benchmarks${path}`;
      const response = await this.fetchImpl(url, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify({ ...scoped, ...body }) } : {}),
      });
      if (response.status === 404) throw new PlatformHttpError(404, "BENCHMARK_NOT_FOUND", "Benchmark not found", instance);
      if (response.status === 409) throw new PlatformHttpError(409, "BENCHMARK_DATASET_EXISTS", "A dataset with this name already exists", instance);
      if (response.status === 400 || response.status === 422) throw new PlatformHttpError(400, "BENCHMARK_INVALID", "The benchmark request is invalid", instance);
      if (!response.ok) throw new PlatformHttpError(502, "BENCHMARK_SERVICE_ERROR", "Benchmarks are temporarily unavailable", instance);
      return await response.json();
    } catch (error) {
      if (error instanceof PlatformHttpError) throw error;
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new PlatformHttpError(timedOut ? 504 : 502, "BENCHMARK_SERVICE_ERROR", "Benchmarks are temporarily unavailable", instance);
    } finally { clearTimeout(timer); }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, instance: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformHttpError(400, "BENCHMARK_INVALID", "The benchmark request is invalid", instance);
  return parsed.data;
}
