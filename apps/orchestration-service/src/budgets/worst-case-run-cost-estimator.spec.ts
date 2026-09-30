import type { CompiledDag } from "@alterx/contracts";
import { describe, expect, it, vi } from "vitest";

import { ConfigModelPolicy } from "./config-model-policy";
import { HttpRunEstimatesLedger } from "./http-run-estimates-ledger";
import { modelCallsOf } from "./model-calls";
import { PRIMARY_PRICING_PROVIDER, WorstCaseRunCostEstimator, type RunEstimatesLedger } from "./worst-case-run-cost-estimator";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";

function dag(nodes: { key: string; type: string; config?: Record<string, unknown> }[]): CompiledDag {
  return {
    schema_version: "v1",
    entry_node_keys: [nodes[0]!.key],
    nodes: nodes.map((node) => ({ key: node.key, type: node.type, config: node.config ?? {}, metadata: { ui: {} } })),
    edges: [],
    waves: [{ key: "wave_0", order: 0, node_keys: nodes.map((node) => node.key), depends_on: [] }],
  } as unknown as CompiledDag;
}

describe("modelCallsOf", () => {
  it("finds a call per LLMTask with a valid alias and per Synthesis, and skips the rest", () => {
    const calls = modelCallsOf(
      dag([
        { key: "a", type: "LLMTask", config: { model_alias: "FAST" } },
        { key: "b", type: "LLMTask", config: { model_alias: "not-an-alias" } },
        { key: "c", type: "LLMTask" },
        { key: "d", type: "ToolCall" },
        { key: "e", type: "Synthesis" },
      ]),
    );
    expect(calls).toEqual([
      { nodeKey: "a", alias: "FAST" },
      { nodeKey: "e", alias: "ADVANCED" },
    ]);
  });
});

describe("WorstCaseRunCostEstimator", () => {
  const policy = {
    modelsFor: vi.fn(async (alias: string) => [{ provider: PRIMARY_PRICING_PROVIDER, modelId: `model-${alias}` }]),
    maxTokensPerCall: vi.fn(async () => 4096),
  };
  const ledgerReturning = (billableMinor: number, unpricedLines = 0) => {
    const worstCase = vi.fn(async () => ({ billableMinor, unpricedLines }));
    return { ledger: { worstCase, runsAverage: vi.fn() } satisfies RunEstimatesLedger, worstCase };
  };

  it("sends one line per model call, at the tenant's token cap, and returns the ledger's bound", async () => {
    const { ledger, worstCase } = ledgerReturning(750);
    const estimator = new WorstCaseRunCostEstimator(policy, ledger);
    const result = await estimator.estimate({
      tenantId: TENANT,
      compiledDag: dag([
        { key: "a", type: "LLMTask", config: { model_alias: "FAST" } },
        { key: "b", type: "LLMTask", config: { model_alias: "FAST" } },
        { key: "c", type: "Synthesis" },
      ]),
    });
    expect(result).toEqual({ billableMinor: 750, modelCalls: 3, unpricedCalls: 0 });
    expect(policy.maxTokensPerCall).toHaveBeenCalledWith(`ten_${TENANT}`);
    const [request] = worstCase.mock.calls[0] as unknown as [{ tenantId: string; lines: { models: unknown[]; maxTokens: string }[] }];
    expect(request.tenantId).toBe(`ten_${TENANT}`);
    expect(request.lines.map((line) => line.maxTokens)).toEqual(["4096", "4096", "4096"]);
    expect(request.lines[0]!.models).toEqual([{ provider: "aws-bedrock", modelId: "model-FAST" }]);
    expect(request.lines[2]!.models).toEqual([{ provider: "aws-bedrock", modelId: "model-ADVANCED" }]);
  });

  it("asks the policy once per alias, not once per node", async () => {
    policy.modelsFor.mockClear();
    const estimator = new WorstCaseRunCostEstimator(policy, ledgerReturning(1).ledger);
    await estimator.estimate({
      tenantId: TENANT,
      compiledDag: dag(["a", "b", "c"].map((key) => ({ key, type: "LLMTask", config: { model_alias: "STANDARD" } }))),
    });
    expect(policy.modelsFor).toHaveBeenCalledTimes(1);
  });

  it("a workflow with no model calls costs nothing to reserve and never calls the ledger", async () => {
    const { ledger, worstCase } = ledgerReturning(999);
    const estimator = new WorstCaseRunCostEstimator(policy, ledger);
    await expect(estimator.estimateMinor({ tenantId: TENANT, workflowId: "wf_1", compiledDag: dag([{ key: "a", type: "ToolCall" }]) })).resolves.toBe(0);
    expect(worstCase).not.toHaveBeenCalled();
  });

  it("reports the calls the ledger could not price", async () => {
    const estimator = new WorstCaseRunCostEstimator(policy, ledgerReturning(100, 1).ledger);
    await expect(
      estimator.estimate({ tenantId: TENANT, compiledDag: dag([{ key: "a", type: "LLMTask", config: { model_alias: "CEILING" } }]) }),
    ).resolves.toMatchObject({ unpricedCalls: 1 });
  });
});

describe("ConfigModelPolicy", () => {
  it("lists the alias's own model first, then its fallbacks, and reads the tenant's token cap", async () => {
    const config = {
      resolveModelAlias: vi.fn(async () => ({
        model_id: "primary",
        capability_tags: [],
        fallback_chain: [{ provider: "anthropic", model_id: "claude" }],
      })),
      resolveCostLimit: vi.fn(async () => ({ maxTokensPerCall: 2000, maxCostUsdPerCall: 1 })),
    };
    const policy = new ConfigModelPolicy(config as never);
    await expect(policy.modelsFor("FAST")).resolves.toEqual([
      { provider: "aws-bedrock", modelId: "primary" },
      { provider: "anthropic", modelId: "claude" },
    ]);
    await expect(policy.maxTokensPerCall(`ten_${TENANT}`)).resolves.toBe(2000);
    expect(config.resolveCostLimit).toHaveBeenCalledWith({ tenantId: `ten_${TENANT}`, runId: "run_estimate" });
  });
});

describe("HttpRunEstimatesLedger", () => {
  const tokens = { getAccessToken: async () => "tok" };

  it("posts the worst-case lines with the service token and reads whole amounts", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ internal_minor: "10", billable_minor: "13", unpriced_lines: "1" })));
    const ledger = new HttpRunEstimatesLedger("http://costs.test/", tokens, fetchImpl as unknown as typeof fetch);
    await expect(ledger.worstCase({ tenantId: `ten_${TENANT}`, lines: [{ models: [{ provider: "p", modelId: "m" }], maxTokens: "100" }] })).resolves.toEqual({
      billableMinor: 13,
      unpricedLines: 1,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("http://costs.test/costs/worst-case");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ tenantId: `ten_${TENANT}`, lines: [{ models: [{ provider: "p", modelId: "m" }], maxTokens: "100" }] });
  });

  it("reads an average, and null when the runs have no cost data", async () => {
    const answer = (body: unknown) => new HttpRunEstimatesLedger("http://costs.test", tokens, (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch);
    const input = { tenantId: `ten_${TENANT}`, workspaceId: "ws_x", runIds: ["run_1"] };
    await expect(answer({ average_billable_minor: "89", run_count: "5" }).runsAverage(input)).resolves.toEqual({ averageBillableMinor: 89, runCount: 5 });
    await expect(answer({ average_billable_minor: null, run_count: "0" }).runsAverage(input)).resolves.toEqual({ averageBillableMinor: null, runCount: 0 });
  });

  it("fails loudly on an error status or a malformed amount rather than guessing a cost", async () => {
    const answer = (response: Response) => new HttpRunEstimatesLedger("http://costs.test", tokens, (async () => response) as unknown as typeof fetch);
    const lines = [{ models: [{ provider: "p", modelId: "m" }], maxTokens: "1" }];
    await expect(answer(new Response("no", { status: 502 })).worstCase({ tenantId: "t", lines })).rejects.toThrow("answered 502");
    await expect(answer(new Response(JSON.stringify({ billable_minor: "-1", unpriced_lines: 0 }))).worstCase({ tenantId: "t", lines })).rejects.toThrow("not a whole amount");
  });
});
