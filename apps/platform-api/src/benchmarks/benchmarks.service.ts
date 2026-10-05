import { Injectable } from "@nestjs/common";

import {
  EvalFacadeClient,
  type CheckReleaseGateResponse,
  type RunEvaluationResponse,
} from "../engine";
import { EvalHistoryClient, historyQuerySchema } from "./history.client";
import { BenchmarksHttpError } from "./problem";

@Injectable()
export class BenchmarksService {
  constructor(private readonly evalFacade: EvalFacadeClient, private readonly history: EvalHistoryClient) {}

  listRuns(query: unknown, traceparent?: string) {
    const parsed = historyQuerySchema.safeParse(query);
    if (!parsed.success) throw new BenchmarksHttpError(400,"BENCHMARKS_VALIDATION_FAILED","Invalid history query","/api/v1/admin/benchmarks/runs");
    return this.history.list(parsed.data,traceparent);
  }

  run(
    body: unknown,
    traceparent: string | undefined,
  ): Promise<RunEvaluationResponse> {
    const instance = "/api/v1/admin/benchmarks/actions/run";
    return this.evalFacade.runEvaluation(parseRunInput(body, instance), traceparent);
  }

  releaseGate(
    gateId: string,
    evaluationRunId: string | undefined,
    traceparent: string | undefined,
  ): Promise<CheckReleaseGateResponse> {
    const instance = `/api/v1/admin/benchmarks/release-gates/${encodeURIComponent(gateId)}`;
    if (!nonEmptyString(gateId) || !nonEmptyString(evaluationRunId)) {
      throw new BenchmarksHttpError(
        400,
        "BENCHMARKS_VALIDATION_FAILED",
        "gateId and evaluation_run_id are required",
        instance,
      );
    }
    return this.evalFacade.checkReleaseGate({
      release_gate_key: gateId,
      evaluation_run_id: evaluationRunId,
    }, traceparent);
  }
}

function parseRunInput(
  value: unknown,
  instance: string,
): { readonly golden_set_name: string } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !nonEmptyString(value.golden_set_name)) {
    throw new BenchmarksHttpError(
      400,
      "BENCHMARKS_VALIDATION_FAILED",
      "golden_set_name is required",
      instance,
    );
  }
  return { golden_set_name: value.golden_set_name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
