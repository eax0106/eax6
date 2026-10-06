import type { CompiledDag, ScoreNodeInlineRequest, ScoreNodeInlineResponse } from "@alterx/contracts";
import { describe, expect, it, vi } from "vitest";

import { GateHandler } from "../registry/handlers/gate.handler";
import { LlmTaskHandler } from "../registry/handlers/llmtask.handler";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import type { VerificationGateReader } from "../registry/verification-gate-reader";
import {
  BenchmarkCaseSimulator,
  BenchmarkWorkflowNotInWorkspaceError,
} from "./benchmark-case-simulator";

const tenantId = "ten_01930000-0000-7000-8000-000000000001";
const workspace = "01930000-0000-7000-8000-000000000002";
const workflowId = "wf_01930000-0000-7000-8000-000000000003";
const versionId = "wfv_01930000-0000-7000-8000-000000000004";

const dag: CompiledDag = {
  schema_version: "v1",
  entry_node_keys: ["draft"],
  nodes: [
    { key: "draft", type: "LLMTask", config: { model_alias: "STANDARD", prompt: "Write a welcome email" },
      success_criteria: ["Addresses the lead by name"], metadata: { ui: {} } },
    { key: "send", type: "ToolCall", config: { tool_name: "email.send" }, metadata: { ui: {} } },
  ],
  edges: [{ key: "draft-send", from: "draft", to: "send", kind: "sequential" }],
  waves: [
    { key: "write", order: 0, node_keys: ["draft"], depends_on: [] },
    { key: "act", order: 1, node_keys: ["send"], depends_on: ["write"] },
  ],
};

function verdict(value: "pass" | "fail", score = value === "pass" ? 0.9 : 0.2): ScoreNodeInlineResponse {
  return { verdict: value, score, threshold: 0.7, reviewer_model: "reviewer", details_json: "{}" };
}

function setup(options: { dag?: CompiledDag; verdicts?: ScoreNodeInlineResponse[]; invoke?: () => Promise<unknown> } = {}) {
  const invoke = vi.fn<(request: { input_json: string; tenant_id: string; run_id: string }) => Promise<unknown>>(options.invoke ?? (async () => ({
    output_json: JSON.stringify({ subject: "Welcome, Asha", body: "Hello Asha" }),
    usage_json: JSON.stringify({ input_tokens: 120, output_tokens: 30 }),
    estimated_cost_usd: "0.0004",
    resolved_capability: "standard",
  })));
  const toolGateway = { invoke: vi.fn() };
  const scores = [...(options.verdicts ?? [verdict("pass"), verdict("pass")])];
  const verifier = { scoreNodeInline: vi.fn<(request: ScoreNodeInlineRequest) => Promise<ScoreNodeInlineResponse>>(async () => scores.shift() ?? verdict("pass")) };
  const versions = { previewRun: vi.fn(async () => ({ workspaceId: workspace, workflowVersionId: versionId, compiledDag: options.dag ?? dag })) };
  const simulator = new BenchmarkCaseSimulator(
    versions,
    (verification) => new NodeHandlerRegistry([
      new LlmTaskHandler({ invoke } as never),
      new GateHandler(verification),
    ]),
    verifier,
  );
  return { simulator, invoke, toolGateway, verifier, versions };
}

const caseRequest = {
  tenantId,
  workspaceId: `ws_${workspace}`,
  workflowId,
  caseId: "case_1",
  input: { name: "Asha", email: "asha@example.test" },
  successCriteria: ["The email greets Asha"],
};

describe("BenchmarkCaseSimulator", () => {
  it("runs compute nodes for real, never runs outside actions, and judges the case criteria", async () => {
    const { simulator, invoke, verifier } = setup();

    const result = await simulator.simulateCase(caseRequest);

    expect(invoke).toHaveBeenCalledTimes(1);
    const modelRequest = invoke.mock.calls[0]![0];
    expect(modelRequest.tenant_id).toBe(tenantId);
    expect(modelRequest.run_id).toBe(result.simulationRunId);
    expect(modelRequest.input_json).toContain("benchmark.case_1");
    expect(modelRequest.input_json).toContain("asha@example.test");
    expect(result.steps).toEqual([
      { key: "draft", type: "LLMTask", status: "executed", verdict: "pass" },
      { key: "send", type: "ToolCall", status: "simulated", action: "ToolCall:email.send" },
    ]);
    expect(result.output).toEqual({ send: { simulated: true, action: "ToolCall:email.send",
      inputs: { draft: { subject: "Welcome, Asha", body: "Hello Asha" } } } });
    const judged = verifier.scoreNodeInline.mock.calls.at(-1)![0];
    expect(judged.success_criteria).toEqual(["The email greets Asha"]);
    expect(JSON.parse(judged.output_json)).toEqual(result.output);
    expect(result).toMatchObject({ verdict: "pass", score: 0.9, threshold: 0.7, reviewerModel: "reviewer",
      workflowVersionId: versionId, error: null,
      usage: { inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.0004 } });
  });

  it("scores each executed node against its own criteria, as a run does", async () => {
    const { simulator, verifier } = setup();
    await simulator.simulateCase(caseRequest);
    const nodeScore = verifier.scoreNodeInline.mock.calls[0]![0];
    expect(nodeScore.node_key).toBe("draft");
    expect(nodeScore.success_criteria).toEqual(["Addresses the lead by name"]);
  });

  it("fails the case when the case criteria are not met", async () => {
    const { simulator } = setup({ verdicts: [verdict("pass"), verdict("fail")] });
    const result = await simulator.simulateCase(caseRequest);
    expect(result).toMatchObject({ verdict: "fail", score: 0.2, error: null });
  });

  it("stops and fails the case when a node fails its verification", async () => {
    const { simulator, verifier } = setup({ verdicts: [verdict("fail")] });
    const result = await simulator.simulateCase(caseRequest);
    expect(result.verdict).toBe("fail");
    expect(result.error).toBe("Node draft failed its verification");
    expect(result.steps.map((step) => step.key)).toEqual(["draft"]);
    expect(verifier.scoreNodeInline).toHaveBeenCalledTimes(1);
  });

  it("reports a node that cannot execute as an error, without throwing", async () => {
    const { simulator } = setup({ invoke: async () => { throw new Error("gateway unavailable"); } });
    const result = await simulator.simulateCase(caseRequest);
    expect(result).toMatchObject({ verdict: "error", error: "gateway unavailable", score: null });
    expect(result.steps).toEqual([{ key: "draft", type: "LLMTask", status: "failed", error: "gateway unavailable" }]);
  });

  it("evaluates gate conditions over the executed output", async () => {
    const gated: CompiledDag = {
      ...dag,
      nodes: [dag.nodes[0]!, { key: "check", type: "Gate", config: { conditions: { send: "inputs.draft.subject == 'Welcome, Asha'" } }, metadata: { ui: {} } }],
      edges: [{ key: "draft-check", from: "draft", to: "check", kind: "sequential" }],
      waves: [dag.waves[0]!, { key: "act", order: 1, node_keys: ["check"], depends_on: ["write"] }],
    };
    const { simulator } = setup({ dag: gated, verdicts: [verdict("pass"), verdict("pass"), verdict("pass")] });
    const result = await simulator.simulateCase(caseRequest);
    expect(result.steps.find((step) => step.key === "check")).toMatchObject({ status: "executed" });
    expect(result.output).toEqual({ check: { activeSuccessors: ["send"], evaluations: { send: true } } });
  });

  it("serves the scores it recorded to Gate and Synthesis nodes", async () => {
    let reader: VerificationGateReader | undefined;
    const invoke = vi.fn(async () => ({ output_json: "{}", usage_json: "{}", estimated_cost_usd: "", resolved_capability: "standard" }));
    const simulator = new BenchmarkCaseSimulator(
      { previewRun: async () => ({ workspaceId: workspace, workflowVersionId: versionId, compiledDag: dag }) },
      (verification) => { reader = verification; return new NodeHandlerRegistry([new LlmTaskHandler({ invoke } as never)]); },
      { scoreNodeInline: async () => verdict("pass", 0.95) },
    );
    await simulator.simulateCase(caseRequest);
    expect(await reader!.findForSourceNode({ tenantId, runId: "run_x", sourceNodeKey: "draft" })).toEqual([
      { gateType: "quality", verdict: "pass", score: 0.95, threshold: 0.7, details: {} },
    ]);
    expect(await reader!.findForSourceNode({ tenantId, runId: "run_x", sourceNodeKey: "send" })).toEqual([]);
  });

  it("refuses a workflow from another workspace", async () => {
    const { simulator, versions } = setup();
    versions.previewRun.mockResolvedValueOnce({ workspaceId: "01930000-0000-7000-8000-0000000000ff", workflowVersionId: versionId, compiledDag: dag });
    await expect(simulator.simulateCase(caseRequest)).rejects.toBeInstanceOf(BenchmarkWorkflowNotInWorkspaceError);
  });
});
