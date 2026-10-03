import { describe, expect, it } from "vitest";

import { CompilerValidationError } from "./dag-builder";
import { compileArchitectureToDag, type ArchitectureCompileInput } from "./architecture-dag-builder";

const input = (): ArchitectureCompileInput => ({
  tenant_id: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  workflow_id: "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  dag_schema_version: "v1",
  architecture: {
    status: "ready", version: "1", topology: "parallel", boundaries: [{ kind: "human_approval", after_node_key: "review", reason: "customer-visible" }],
    nodes: [
      { source_node_key: "plan", role: "manager", execution_kind: "llm", depends_on: [], capability_role: { source_node_key: "plan", required_capabilities: ["text"], eligible_kinds: ["model"] } },
      { source_node_key: "review", role: "worker", execution_kind: "deterministic", depends_on: ["plan"], capability_role: { source_node_key: "review", required_capabilities: ["search"], eligible_kinds: ["tool"] } },
    ],
    execution_waves: [{ order: 0, node_keys: ["plan"], depends_on_wave_orders: [] }, { order: 1, node_keys: ["review"], depends_on_wave_orders: [0] }],
  },
  binding_decision: { status: "ready", bindings: [
    { record_id: "model-main", version: 3, kind: "model", source_node_key: "plan", rationale: "best", score: 1, factors: { reliability: 1 } },
    { record_id: "tool-review", version: 2, kind: "tool", source_node_key: "review", rationale: "best", score: 1, factors: { reliability: 1 } },
  ] },
});

describe("compileArchitectureToDag", () => {
  it("retains the original binding reason, factors, policy and required model tier for override advice", () => {
    const value=input();
    value.binding_decision.policy={reliability_weight:.6,latency_weight:.2,cost_weight:.2};
    Object.assign(value.binding_decision.bindings[0]!,{model_alias:"CEILING",required_model_alias:"ADVANCED"});
    value.architecture.nodes[0]!.config={model_alias:"ADVANCED",prompt:"Research the invoice"};
    const node=compileArchitectureToDag(value).nodes.find(item=>item.key==="plan")!;
    expect(node.config.model_alias).toBe("CEILING");
    expect(node.metadata.selection_binding).toEqual({
      binding:{record_id:"model-main",version:3,kind:"model",rationale:"best",score:1,factors:{reliability:1}},
      policy:value.binding_decision.policy,required_capabilities:["text"],required_model_alias:"ADVANCED",model_alias:"CEILING",
    });
    expect(node.config).not.toHaveProperty("selection_binding");
  });

  it("lowers pinned bindings, topology, and approval boundary deterministically", () => {
    const first = compileArchitectureToDag(input());
    expect(compileArchitectureToDag(input())).toEqual(first);
    expect(first.nodes.find((node) => node.key === "review")?.config).toMatchObject({ capability_record_id: "tool-review", capability_version: 2 });
    expect(first.nodes.find((node) => node.key === "human_approval_review")?.type).toBe("HumanApproval");
    expect(first.waves.map((wave) => wave.node_keys)).toEqual([["plan"], ["review"], ["human_approval_review"]]);
  });

  it("carries each node's own configuration into the compiled node", () => {
    const value = input();
    value.architecture.nodes[0]!.config = { model_alias: "FAST", prompt: "Draft the plan." };
    value.architecture.nodes[1]!.config = { command: "pnpm test" };

    const dag = compileArchitectureToDag(value);

    // Without this the compiler emitted only binding identifiers, so every
    // node arrived at the executor missing the prompt or command its handler
    // requires and the run failed on its first node.
    expect(dag.nodes.find((node) => node.key === "plan")?.config).toMatchObject({
      model_alias: "FAST",
      prompt: "Draft the plan.",
      capability_record_id: "model-main",
    });
    expect(dag.nodes.find((node) => node.key === "review")?.config).toMatchObject({
      command: "pnpm test",
      capability_record_id: "tool-review",
    });
  });

  it("carries supplied success criteria onto its compiled node", () => {
    const value = input();
    value.architecture.success_criteria = ["Workflow is ready for review."];
    value.architecture.nodes[0]!.success_criteria = ["Plan is ready for review."];

    const dag = compileArchitectureToDag(value);

    expect(dag.nodes.find((node) => node.key === "plan")?.success_criteria).toEqual([
      "Plan is ready for review.",
    ]);
    expect(dag.success_criteria).toEqual(["Workflow is ready for review."]);
  });

  it("lets binding identifiers win over a colliding skeleton key", () => {
    const value = input();
    value.architecture.nodes[0]!.config = { capability_record_id: "from-skeleton" };

    const dag = compileArchitectureToDag(value);

    expect(dag.nodes.find((node) => node.key === "plan")?.config).toMatchObject({ capability_record_id: "model-main" });
  });

  it.each([
    ["missing binding", (value: ArchitectureCompileInput) => { value.binding_decision.bindings = value.binding_decision.bindings.slice(1); }],
    ["ineligible kind", (value: ArchitectureCompileInput) => { value.binding_decision.bindings[0]!.kind = "tool"; }],
    ["source mismatch", (value: ArchitectureCompileInput) => { value.binding_decision.bindings[0]!.source_node_key = "ghost"; }],
    ["cycle", (value: ArchitectureCompileInput) => { value.architecture.nodes[0]!.depends_on = ["review"]; }],
  ])("rejects %s before lowering", (_name, mutate) => {
    const value = input(); mutate(value);
    expect(() => compileArchitectureToDag(value)).toThrow(CompilerValidationError);
  });
});

describe("compileArchitectureToDag boundaries", () => {
  // draft_a, draft_b -> send (a tool with no binding, as the resolver leaves tool nodes)
  const actionInput = (boundaries: ArchitectureCompileInput["architecture"]["boundaries"]): ArchitectureCompileInput => ({
    ...input(),
    architecture: {
      status: "ready", version: "1", topology: "parallel", boundaries,
      nodes: [
        { source_node_key: "draft_a", role: "direct", execution_kind: "llm", depends_on: [], config: { model_alias: "STANDARD", prompt: "A" } },
        { source_node_key: "draft_b", role: "direct", execution_kind: "llm", depends_on: [], config: { model_alias: "STANDARD", prompt: "B" } },
        { source_node_key: "send", role: "deterministic", execution_kind: "deterministic", depends_on: ["draft_a", "draft_b"], config: { tool_name: "email_send", arguments: {} } },
      ],
      execution_waves: [{ order: 0, node_keys: ["draft_a", "draft_b"], depends_on_wave_orders: [] }, { order: 1, node_keys: ["send"], depends_on_wave_orders: [0] }],
    },
    binding_decision: { status: "ready", bindings: [] },
  });
  const edge = (dag: ReturnType<typeof compileArchitectureToDag>, from: string, to: string) =>
    dag.edges.find((candidate) => candidate.from === from && candidate.to === to);
  const waveOf = (dag: ReturnType<typeof compileArchitectureToDag>, key: string) =>
    dag.waves.find((wave) => wave.node_keys.includes(key))?.order;

  it("lowers an unbound deterministic node as a ToolCall, not an LLMTask", () => {
    const dag = compileArchitectureToDag(actionInput([]));
    expect(dag.nodes.find((node) => node.key === "send")?.type).toBe("ToolCall");
  });

  it("verifies every input of an external action through a chained gate before it runs", () => {
    const dag = compileArchitectureToDag(actionInput([{ kind: "verification", before_node_key: "send", reason: "verification precedes every external action" }]));

    const first = dag.nodes.find((node) => node.key === "verification_before_send_0");
    const second = dag.nodes.find((node) => node.key === "verification_before_send_1");
    // Real verification config -- GateHandler rejects a gate with neither
    // verification nor conditions, which is what boundaries lowered to before.
    expect(first).toMatchObject({ type: "Gate", config: { verification: { source_node_key: "draft_a", protected_node_key: "verification_before_send_1" } } });
    expect(second).toMatchObject({ type: "Gate", config: { verification: { source_node_key: "draft_b", protected_node_key: "send" } } });
    // Chained, so both must pass: the Executor unlocks a node when ANY
    // conditional predecessor allows it.
    expect(edge(dag, "verification_before_send_0", "verification_before_send_1")?.kind).toBe("conditional");
    expect(edge(dag, "verification_before_send_1", "send")?.kind).toBe("conditional");
    expect(dag.edges.filter((candidate) => candidate.to === "send" && candidate.kind === "conditional")).toHaveLength(1);
    // The action still receives its real inputs.
    expect(edge(dag, "draft_a", "send")?.kind).toBe("sequential");
    expect(edge(dag, "draft_b", "send")?.kind).toBe("sequential");
    // And runs in a later wave than every gate.
    expect(waveOf(dag, "verification_before_send_0")).toBeLessThan(waveOf(dag, "verification_before_send_1")!);
    expect(waveOf(dag, "verification_before_send_1")).toBeLessThan(waveOf(dag, "send")!);
    expect(dag.entry_node_keys).toEqual(["draft_a", "draft_b"]);
  });

  it("asks for approval before verification before the action", () => {
    const dag = compileArchitectureToDag(actionInput([
      { kind: "verification", before_node_key: "send", reason: "verification precedes every external action" },
      { kind: "human_approval", before_node_key: "send", reason: "customer-visible output" },
    ]));

    expect(dag.nodes.find((node) => node.key === "human_approval_before_send")).toMatchObject({ type: "HumanApproval", config: { requested_action: { kind: "run_node", node_key: "send" } } });
    expect(edge(dag, "draft_a", "human_approval_before_send")).toBeDefined();
    expect(edge(dag, "human_approval_before_send", "verification_before_send_0")).toBeDefined();
    expect(waveOf(dag, "human_approval_before_send")).toBeLessThan(waveOf(dag, "verification_before_send_0")!);
    expect(waveOf(dag, "verification_before_send_1")).toBeLessThan(waveOf(dag, "send")!);
  });

  it("rejects verification before an external action with no input to verify", () => {
    const value = actionInput([{ kind: "verification", before_node_key: "send", reason: "x" }]);
    value.architecture.nodes[2]!.depends_on = [];
    expect(() => compileArchitectureToDag(value)).toThrow(/cannot be a source node/);
  });

  it("verifies delivered output, then asks for approval of the verified output", () => {
    const dag = compileArchitectureToDag(actionInput([
      { kind: "verification", after_node_key: "draft_a", reason: "output contains personal data" },
      { kind: "human_approval", after_node_key: "draft_a", reason: "customer-visible output" },
    ]));

    expect(dag.nodes.find((node) => node.key === "verification_draft_a")).toMatchObject({ type: "Gate", config: { verification: { source_node_key: "draft_a", protected_node_key: "human_approval_draft_a" } } });
    expect(edge(dag, "verification_draft_a", "human_approval_draft_a")?.kind).toBe("conditional");
    expect(dag.nodes.find((node) => node.key === "human_approval_draft_a")?.type).toBe("HumanApproval");
  });

  it.each([
    ["no placement", { kind: "verification" as const, reason: "x" }],
    ["both placements", { kind: "verification" as const, before_node_key: "send", after_node_key: "send", reason: "x" }],
  ])("rejects a boundary with %s", (_name, boundary) => {
    expect(() => compileArchitectureToDag(actionInput([boundary]))).toThrow(CompilerValidationError);
  });
});

describe("compileArchitectureToDag control nodes", () => {
  type Node = ArchitectureCompileInput["architecture"]["nodes"][number];
  const llm = (key: string, depends_on: string[] = []): Node => ({ source_node_key: key, role: "direct", execution_kind: "llm", source_node_type: "llm", depends_on, config: { model_alias: "STANDARD", prompt: key } });
  const tool = (key: string, depends_on: string[]): Node => ({ source_node_key: key, role: "deterministic", execution_kind: "deterministic", source_node_type: "tool", depends_on, config: { tool_name: key, arguments: {} } });
  const control = (key: string, type: "branch" | "join", depends_on: string[], config: Record<string, unknown> = {}): Node => ({ source_node_key: key, role: "control", execution_kind: "control", source_node_type: type, depends_on, config });
  const compile = (nodes: Node[], boundaries: ArchitectureCompileInput["architecture"]["boundaries"] = []) => compileArchitectureToDag({
    ...input(),
    architecture: { status: "ready", version: "1", topology: "parallel", boundaries, nodes, execution_waves: [{ order: 0, node_keys: [nodes[0]!.source_node_key], depends_on_wave_orders: [] }] },
    binding_decision: { status: "ready", bindings: [] },
  });
  const edge = (dag: ReturnType<typeof compileArchitectureToDag>, from: string, to: string) => dag.edges.find((candidate) => candidate.from === from && candidate.to === to);

  it("lowers a join to Merge with merge edges, not to a Gate without conditions", () => {
    const dag = compile([llm("plan"), llm("worker_a", ["plan"]), llm("worker_b", ["plan"]), control("collect", "join", ["worker_a", "worker_b"])]);

    expect(dag.nodes.find((node) => node.key === "collect")?.type).toBe("Merge");
    expect(edge(dag, "worker_a", "collect")?.kind).toBe("merge");
    expect(edge(dag, "worker_b", "collect")?.kind).toBe("merge");
  });

  it("lowers a branch to a Gate carrying its conditions, with a conditional edge per successor", () => {
    const dag = compile([
      llm("classify"),
      control("route", "branch", ["classify"], { conditions: { answer_billing: "inputs.classify.topic == 'billing'", answer_other: "inputs.classify.topic != 'billing'" } }),
      llm("answer_billing", ["route"]),
      llm("answer_other", ["route"]),
    ]);

    expect(dag.nodes.find((node) => node.key === "route")).toMatchObject({ type: "Gate", config: { conditions: { answer_billing: "inputs.classify.topic == 'billing'" } } });
    expect(edge(dag, "route", "answer_billing")).toMatchObject({ kind: "conditional", condition: { expression: "inputs.classify.topic == 'billing'", language: "cel" } });
    expect(edge(dag, "route", "answer_other")?.kind).toBe("conditional");
  });

  it.each([
    ["a successor without a condition", { conditions: { answer_billing: "true" } }],
    ["a condition for a node that is not a successor", { conditions: { answer_billing: "true", answer_other: "true", ghost: "true" } }],
  ])("rejects a branch with %s", (_name, config) => {
    expect(() => compile([llm("classify"), control("route", "branch", ["classify"], config), llm("answer_billing", ["route"]), llm("answer_other", ["route"])])).toThrow(CompilerValidationError);
  });

  it("rejects a control node that does not say whether it is a branch or a join", () => {
    const collect = control("collect", "join", ["plan"]);
    delete (collect as { source_node_type?: string }).source_node_type;
    expect(() => compile([llm("plan"), collect])).toThrow(/cannot be told apart/);
  });

  it("lets a branch decide whether the gates before an action run at all", () => {
    const dag = compile(
      [llm("classify"), control("route", "branch", ["classify"], { conditions: { issue_refund: "inputs.classify.refund" } }), tool("issue_refund", ["route"])],
      [
        { kind: "verification", before_node_key: "issue_refund", reason: "verification precedes every external action" },
        { kind: "human_approval", before_node_key: "issue_refund", reason: "customer-visible output" },
      ],
    );

    // The branch now routes to the approval and the first verification gate...
    expect(edge(dag, "route", "human_approval_before_issue_refund")).toMatchObject({ kind: "conditional", condition: { expression: "inputs.classify.refund" } });
    expect(edge(dag, "route", "verification_before_issue_refund_0")).toMatchObject({ kind: "conditional", condition: { expression: "inputs.classify.refund" } });
    expect((dag.nodes.find((node) => node.key === "route")?.config as { conditions: Record<string, string> }).conditions).toMatchObject({
      human_approval_before_issue_refund: "inputs.classify.refund",
      verification_before_issue_refund_0: "inputs.classify.refund",
    });
    // ...and its edge into the action is plain input, so the only conditional
    // edge into the action is the last gate's.
    expect(edge(dag, "route", "issue_refund")?.kind).toBe("sequential");
    expect(dag.edges.filter((candidate) => candidate.to === "issue_refund" && candidate.kind === "conditional").map((candidate) => candidate.from)).toEqual(["verification_before_issue_refund_0"]);
  });
});
