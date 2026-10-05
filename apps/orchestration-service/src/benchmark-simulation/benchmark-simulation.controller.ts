import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { Public as InternalBenchmarkServiceAuth } from "@alterx/auth";
import { TenantIdSchema, WorkflowIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import { z } from "zod";

import { RunValidationError, WorkflowNotFoundError } from "../runs/run-launcher.service";
import { BenchmarkCaseSimulator, BenchmarkWorkflowNotInWorkspaceError } from "./benchmark-case-simulator";

export const BENCHMARK_SIMULATION_TOKEN_HASH = Symbol("BENCHMARK_SIMULATION_TOKEN_HASH");

const SimulateCaseSchema = z.object({
  tenant_id: TenantIdSchema,
  workspace_id: WorkspaceIdSchema,
  workflow_id: WorkflowIdSchema,
  case_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  input: z.record(z.string(), z.unknown()),
  success_criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
}).strict();

/** D25: eval-service runs each benchmark case through Simulate here. */
@InternalBenchmarkServiceAuth()
@Controller("internal/benchmarks")
export class BenchmarkSimulationController {
  constructor(private readonly simulator: BenchmarkCaseSimulator,
    @Inject(BENCHMARK_SIMULATION_TOKEN_HASH) private readonly tokenHash: string) {}

  @Post("simulate-case")
  @HttpCode(200)
  async simulateCase(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const actual = createHash("sha256").update(token).digest(), expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException("Internal service authentication required", 401);
    }
    const parsed = SimulateCaseSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("Invalid benchmark case", 400);
    const request = parsed.data;
    try {
      return await this.simulator.simulateCase({
        tenantId: request.tenant_id,
        workspaceId: request.workspace_id,
        workflowId: request.workflow_id,
        caseId: request.case_id,
        input: request.input,
        successCriteria: request.success_criteria,
      });
    } catch (error: unknown) {
      if (error instanceof WorkflowNotFoundError || error instanceof BenchmarkWorkflowNotInWorkspaceError) {
        throw new HttpException("Workflow not found", 404);
      }
      if (error instanceof RunValidationError) throw new HttpException(error.message, 409);
      throw error;
    }
  }
}
