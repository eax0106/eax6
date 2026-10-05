import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { EngineProblemError, upstreamProblem } from "../engine/problem";

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(256).optional(),
  golden_set: z.string().min(1).max(128).optional(),
}).strict();
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export const historyPageSchema = z.object({
  data: z.array(z.object({
    id: z.uuid(), goldenSetName: z.string(), goldenSetDomain: z.string(),
    goldenSetVersion: z.number().int().positive(), subject: z.string(), trigger: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    passRate: z.number().min(0).max(1).nullable(),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })).max(100),
  nextCursor: z.string().max(256).nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export interface HistoryConfig { baseUrl: string; tokenRef: string; timeoutMs: number }
export function historyConfig(env: NodeJS.ProcessEnv): HistoryConfig {
  const baseUrl = z.url().parse(env.EVAL_HISTORY_BASE_URL ?? `http://127.0.0.1:${env.EVAL_SERVICE_PORT ?? "8003"}`);
  const url = new URL(baseUrl);
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid evaluation history service URL");
  return { baseUrl: baseUrl.replace(/\/$/, ""), tokenRef: "env:INTERNAL_SERVICE_TOKEN", timeoutMs: 10_000 };
}

/** @driver listRuns serves GET /api/v1/admin/benchmarks/runs; its deadline cancels the upstream request. */
@Injectable()
export class EvalHistoryClient {
  constructor(private readonly config: HistoryConfig,
    private readonly resolveSecret: (reference: string) => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async list(query: HistoryQuery, traceparent?: string): Promise<HistoryPage> {
    const instance = "/api/v1/admin/benchmarks/runs";
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const token = await this.resolveSecret(this.config.tokenRef);
      if (!token) throw new Error("Missing history service credential");
      const params = new URLSearchParams({ limit: String(query.limit), ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.golden_set ? { golden_set: query.golden_set } : {}) });
      const response = await this.fetchImpl(`${this.config.baseUrl}/internal/evaluation-history?${params}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(traceparent ? { traceparent } : {}) }, signal: controller.signal,
      });
      if (!response.ok) throw new EngineProblemError(upstreamProblem(response.status === 503 ? 503 : response.status === 400 ? 400 : 502,instance,"UPSTREAM_SERVICE_ERROR"));
      return historyPageSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof EngineProblemError) throw error;
      throw new EngineProblemError(upstreamProblem(error instanceof Error && error.name === "AbortError" ? 504 : 502, instance,"UPSTREAM_SERVICE_ERROR"));
    } finally { clearTimeout(timer); }
  }
}
