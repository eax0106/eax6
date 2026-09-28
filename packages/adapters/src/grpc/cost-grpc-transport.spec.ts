import { describe, expect, it, vi } from "vitest";

import type {
  CostIngestCostEventRequest,
  CostQueryRollupsRequest,
  CostRecordModelOutcomeRequest,
} from "@alterx/contracts";
import { CostGrpcController, type CostHandler } from "./cost-grpc-transport";

const REQUEST: CostIngestCostEventRequest = {
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  cost_event_id: "cst_018f47a5-7b2c-7d10-8f11-123456789abc",
  run_id: "run_018f47a5-7b2c-7d10-8f11-123456789abc",
  node_execution_id: "node_018f47a5-7b2c-7d10-8f11-123456789abc",
  provider_reference: "aws-bedrock",
  usage_json: JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
  amount_json: JSON.stringify({ usd: 0.001, estimated: true }),
  source: "model_gateway",
  occurred_at: "2026-07-31T00:00:00.000Z",
};

const ROLLUP_REQUEST: CostQueryRollupsRequest = {
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  start_at: "2026-07-01T00:00:00.000Z",
  end_at: "2026-07-31T00:00:00.000Z",
  dimensions: ["mode"],
  parent_id: "",
  currency: "INR",
};

const RECORD_MODEL_OUTCOME_REQUEST: CostRecordModelOutcomeRequest = {
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  provider: "aws-bedrock",
  resource: "tokens",
  verdict: "success",
  run_id: "run_018f47a5-7b2c-7d10-8f11-123456789abc",
  node_execution_id: "node_018f47a5-7b2c-7d10-8f11-123456789abc",
  recorded_at: "2026-08-19T00:00:00.000Z",
};

class NamedCostError extends Error {
  constructor(name: string) {
    super("safe ingestion error");
    this.name = name;
  }
}

function handler(): CostHandler {
  return {
    ingestCostEvent: vi.fn(async () => ({ accepted: true })),
    resolveUnitPrice: vi.fn(async () => ({ unit_cost_minor: "0", currency: "INR", confidence: "no_data" })),
    queryRollups: vi.fn(async () => ({ rollups_json: "{}" })),
    recordModelOutcome: vi.fn(async () => ({ accepted: true })),
    recordRunVerdict: vi.fn(async () => ({ recorded: true })),
  };
}

describe("CostGrpcController", () => {
  it("delegates the locked IngestCostEvent request/response shape", async () => {
    const costHandler = handler();
    const controller = new CostGrpcController(costHandler);
    await expect(controller.ingestCostEvent(REQUEST)).resolves.toEqual({
      accepted: true,
    });
    expect(costHandler.ingestCostEvent).toHaveBeenCalledWith(REQUEST);
  });

  it.each([
    ["CostValidationError", 3],
    ["CostUnrecognizedSourceError", 3],
  ] as const)("maps %s to gRPC status %s", async (name, code) => {
    const failing = handler();
    failing.ingestCostEvent = vi.fn(async () => {
      throw new NamedCostError(name);
    });
    const controller = new CostGrpcController(failing);
    await expect(controller.ingestCostEvent(REQUEST)).rejects.toMatchObject({
      error: { code },
    });
  });

  it("hides unexpected internal details", async () => {
    const failing = handler();
    failing.ingestCostEvent = vi.fn(async () => {
      throw new Error("database credential leaked if propagated");
    });
    const controller = new CostGrpcController(failing);
    await expect(controller.ingestCostEvent(REQUEST)).rejects.toMatchObject({
      error: {
        code: 13,
        message: "Cost Ledger request could not be completed",
      },
    });
  });

  it("delegates the real QueryRollups request/response shape (OUT-5)", async () => {
    const costHandler = handler();
    costHandler.queryRollups = vi.fn(async () => ({ rollups_json: '{"totals":{}}' }));
    const controller = new CostGrpcController(costHandler);
    await expect(controller.queryRollups(ROLLUP_REQUEST)).resolves.toEqual({
      rollups_json: '{"totals":{}}',
    });
    expect(costHandler.queryRollups).toHaveBeenCalledWith(ROLLUP_REQUEST);
  });

  it("maps RollupValidationError to gRPC INVALID_ARGUMENT", async () => {
    const failing = handler();
    failing.queryRollups = vi.fn(async () => {
      throw new NamedCostError("RollupValidationError");
    });
    const controller = new CostGrpcController(failing);
    await expect(controller.queryRollups(ROLLUP_REQUEST)).rejects.toMatchObject({
      error: { code: 3 },
    });
  });

  it("delegates the real RecordModelOutcome request/response shape (Issue #15)", async () => {
    const costHandler = handler();
    const controller = new CostGrpcController(costHandler);
    await expect(
      controller.recordModelOutcome(RECORD_MODEL_OUTCOME_REQUEST),
    ).resolves.toEqual({ accepted: true });
    expect(costHandler.recordModelOutcome).toHaveBeenCalledWith(
      RECORD_MODEL_OUTCOME_REQUEST,
    );
  });

  it("maps ModelOutcomesValidationError to gRPC INVALID_ARGUMENT", async () => {
    const failing = handler();
    failing.recordModelOutcome = vi.fn(async () => {
      throw new NamedCostError("ModelOutcomesValidationError");
    });
    const controller = new CostGrpcController(failing);
    await expect(
      controller.recordModelOutcome(RECORD_MODEL_OUTCOME_REQUEST),
    ).rejects.toMatchObject({ error: { code: 3 } });
  });

  it("delegates RecordRunVerdict and refuses a rewritten verdict as a failed precondition (C5)", async () => {
    const costHandler = handler();
    const controller = new CostGrpcController(costHandler);
    const request = {
      tenant_id: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1",
      run_id: "run_018f4d6e-2b4a-7a3e-8c1a-1234567890b2",
      verdict: "completed_verified",
      decided_at: "2026-09-28T10:00:00.000Z",
    };

    await expect(controller.recordRunVerdict(request)).resolves.toEqual({ recorded: true });

    vi.mocked(costHandler.recordRunVerdict).mockRejectedValueOnce(new NamedCostError("RunVerdictConflictError"));
    const error = await controller.recordRunVerdict(request).catch((caught: unknown) => caught);
    expect((error as { getError(): { code: number } }).getError().code).toBe(9);
  });
});
