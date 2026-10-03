import { describe, expect, it, vi } from "vitest";

import type { CostIngestCostEventRequest } from "@alterx/contracts";
import {
  CostIngestService,
  CostUnrecognizedSourceError,
  CostValidationError,
  type CostEventStore,
  type CostEventTransaction,
} from "./cost-ingest.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const BARE_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const COST_EVENT = "cst_018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1111abcd1111";
const NODE = "node_018f4d6e-2b4a-7a3e-8c1a-2222abcd2222";
const WORKSPACE = "ws_018f4d6e-2b4a-7a3e-8c1a-3333abcd3333";
const WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-4444abcd4444";
const USD_TO_INR_RATE = 83;

function baseRequest(overrides: Partial<CostIngestCostEventRequest> = {}): CostIngestCostEventRequest {
  return {
    tenant_id: TENANT,
    cost_event_id: COST_EVENT,
    run_id: RUN,
    node_execution_id: NODE,
    provider_reference: "aws-bedrock",
    usage_json: JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
    amount_json: JSON.stringify({ usd: 0.0015, estimated: true }),
    source: "model_gateway",
    occurred_at: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function fakeStore(): { store: CostEventStore; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  const tx: CostEventTransaction = { query };
  return {
    query,
    store: {
      withTenant: async (tenantId, operation) => {
        expect(tenantId).toBe(BARE_TENANT);
        return operation(tx);
      },
    },
  };
}

function fakeRunsClient() {
  return {
    getRunWorkspace: vi.fn(async () => ({
      workspace_id: WORKSPACE,
      workflow_id: WORKFLOW,
    })),
    getNodeExecutionRecoveryInfo: vi.fn(async () => ({
      is_retry: false,
      is_recovery: false,
    })),
  };
}

describe("CostIngestService.ingestCostEvent", () => {
  it("records a workspace-only assistant model call and rejects other sources without a workflow parent", async () => {
    const { store, query } = fakeStore(), runs = fakeRunsClient();
    runs.getRunWorkspace.mockResolvedValue({ workspace_id: WORKSPACE, workflow_id: "" });
    const service = new CostIngestService(store, runs, USD_TO_INR_RATE);
    expect(await service.ingestCostEvent(baseRequest())).toEqual({ accepted: true });
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1].slice(1, 6)).toEqual([
      BARE_TENANT, WORKSPACE.slice(3), null, RUN.slice(4), NODE.slice(5),
    ]);
    await expect(service.ingestCostEvent(baseRequest({ source: "sandbox", usage_json: JSON.stringify({ resource_type: "sandbox.calculator.compute", provider: "sandbox-calculator", units: 1, outcome: "success" }) }))).rejects.toThrow(CostValidationError);
  });
  it("resolves workspace_id via the Runs client and inserts a real bare-uuid row", async () => {
    const { store, query } = fakeStore();
    const runsClient = fakeRunsClient();
    const service = new CostIngestService(store, runsClient, USD_TO_INR_RATE);

    await expect(service.ingestCostEvent(baseRequest())).resolves.toEqual({
      accepted: true,
    });

    expect(runsClient.getRunWorkspace).toHaveBeenCalledWith({
      tenant_id: TENANT,
      run_id: RUN,
    });
    const [statement, values] = query.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain("INSERT INTO cost_events");
    expect(values).toEqual([
      "018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef",
      BARE_TENANT,
      "018f4d6e-2b4a-7a3e-8c1a-3333abcd3333",
      "018f4d6e-2b4a-7a3e-8c1a-4444abcd4444",
      "018f4d6e-2b4a-7a3e-8c1a-1111abcd1111",
      "018f4d6e-2b4a-7a3e-8c1a-2222abcd2222",
      "model_gateway",
      "aws-bedrock",
      "tokens",
      "15",
      "tokens",
      "12", // round(0.0015 * 83 * 100) = 12.45 -> 12
      "2026-07-31T00:00:00.000Z",
      false,
      false,
      "83", // fx_rate_used: the configured usdToInrRate applied to this row
      "0.0015", // amount_usd: the original amount_json.usd, unrounded
    ]);
  });

  it("writes real is_retry/is_recovery from the Runs client, not hardcoded false", async () => {
    const { store, query } = fakeStore();
    const runsClient = {
      getRunWorkspace: vi.fn(async () => ({
        workspace_id: WORKSPACE,
        workflow_id: WORKFLOW,
      })),
      getNodeExecutionRecoveryInfo: vi.fn(async () => ({
        is_retry: true,
        is_recovery: true,
      })),
    };
    const service = new CostIngestService(store, runsClient, USD_TO_INR_RATE);

    await service.ingestCostEvent(baseRequest());

    expect(runsClient.getNodeExecutionRecoveryInfo).toHaveBeenCalledWith({
      tenant_id: TENANT,
      run_id: RUN,
      node_execution_id: NODE,
    });
    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values.at(-4)).toBe(true); // is_retry
    expect(values.at(-3)).toBe(true); // is_recovery
  });

  it("derives sandbox usage_json into resource/quantity/unit correctly", async () => {
    const { store, query } = fakeStore();
    const service = new CostIngestService(store, fakeRunsClient(), USD_TO_INR_RATE);

    await service.ingestCostEvent(
      baseRequest({
        source: "sandbox",
        usage_json: JSON.stringify({
          resource_type: "sandbox.calculator.compute",
          provider: "sandbox-calculator",
          units: 1,
          outcome: "success",
        }),
      }),
    );

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values.slice(8, 11)).toEqual([
      "sandbox.calculator.compute",
      "1",
      "invocations",
    ]);
  });

  it("rejects a source with no known ingestion rule", async () => {
    const service = new CostIngestService(
      fakeStore().store,
      fakeRunsClient(),
      USD_TO_INR_RATE,
    );

    await expect(
      service.ingestCostEvent(baseRequest({ source: "storage" })),
    ).rejects.toThrow(CostUnrecognizedSourceError);
  });

  it("rejects a malformed tenant_id before calling the Runs client", async () => {
    const runsClient = fakeRunsClient();
    const service = new CostIngestService(
      fakeStore().store,
      runsClient,
      USD_TO_INR_RATE,
    );

    await expect(
      service.ingestCostEvent(baseRequest({ tenant_id: "not-a-tenant" })),
    ).rejects.toThrow(CostValidationError);
    expect(runsClient.getRunWorkspace).not.toHaveBeenCalled();
  });

  it("rejects non-numeric model_gateway usage_json fields", async () => {
    const service = new CostIngestService(
      fakeStore().store,
      fakeRunsClient(),
      USD_TO_INR_RATE,
    );

    await expect(
      service.ingestCostEvent(
        baseRequest({ usage_json: JSON.stringify({ input_tokens: "many" }) }),
      ),
    ).rejects.toThrow(CostValidationError);
  });

  it("rejects a negative amount_json.usd", async () => {
    const service = new CostIngestService(
      fakeStore().store,
      fakeRunsClient(),
      USD_TO_INR_RATE,
    );

    await expect(
      service.ingestCostEvent(
        baseRequest({ amount_json: JSON.stringify({ usd: -1 }) }),
      ),
    ).rejects.toThrow(CostValidationError);
  });

  it("relies on the real idempotent INSERT WHERE NOT EXISTS clause for SQS at-least-once redelivery", async () => {
    const { store, query } = fakeStore();
    const service = new CostIngestService(store, fakeRunsClient(), USD_TO_INR_RATE);

    await service.ingestCostEvent(baseRequest());

    const [statement] = query.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain("WHERE NOT EXISTS (SELECT 1 FROM cost_events WHERE id = $1)");
  });
});
