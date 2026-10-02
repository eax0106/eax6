import { z } from "zod";

import { ConnectorTypeSchema, CompiledDagSchema, type CompiledDag, type NodeType } from "@alterx/contracts";

import { CompilerValidationError, computeWaves, extractGateConditions, validateGateConditionCoverage } from "./dag-builder";

const NodeKey = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/i);
const CapabilityKind = z.enum(["agent", "model", "tool", "connector", "execution"]);
const ArchitectureNode = z.object({
  source_node_key: NodeKey,
  role: z.enum(["direct", "manager", "worker", "deterministic", "control"]),
  execution_kind: z.enum(["llm", "deterministic", "control"]),
  // The skeleton node type synthesis started from. execution_kind "control"
  // covers both branch and join, which lower to different node types.
  source_node_type: z.enum(["llm", "tool", "branch", "join"]).optional(),
  depends_on: z.array(NodeKey),
  capability_role: z.object({
    source_node_key: NodeKey,
    required_capabilities: z.array(z.string().min(1)),
    eligible_kinds: z.array(CapabilityKind).min(1),
  }).strict().nullable().optional(),
  // Carried through synthesis from the task skeleton: the node's prompt, its
  // command, whatever its handler requires. Optional, so an architecture
  // produced before synthesis carried it still compiles -- into exactly the
  // configuration-free DAG it produced before.
  config: z.record(z.string(), z.unknown()).optional(),
  success_criteria: z.array(z.string().trim().min(1)).min(1).nullable().optional(),
}).strict();
const ArchitectureSpec = z.object({
  status: z.literal("ready"),
  version: z.literal("1"),
  topology: z.enum(["single", "deterministic", "sequential", "parallel", "manager_worker"]),
  nodes: z.array(ArchitectureNode).min(1),
  execution_waves: z.array(z.object({
    order: z.number().int().nonnegative(), node_keys: z.array(NodeKey).min(1), depends_on_wave_orders: z.array(z.number().int().nonnegative()),
  }).strict()).min(1),
  // Exactly one placement. before_node_key gates entry to a node -- the only
  // placement that can stop an external action; after_node_key gates a node's
  // output on its way out of the run.
  boundaries: z.array(z.object({
    kind: z.enum(["verification", "human_approval"]), after_node_key: NodeKey.nullable().optional(), before_node_key: NodeKey.nullable().optional(), reason: z.string().min(1),
  }).strict().refine((boundary) => (boundary.after_node_key == null) !== (boundary.before_node_key == null), { message: "a boundary needs exactly one of before_node_key or after_node_key" })),
  success_criteria: z.array(z.string().trim().min(1)).min(1).nullable().optional(),
}).passthrough();
const BindingDecision = z.object({
  status: z.literal("ready"),
  bindings: z.array(z.object({
    record_id: z.string().min(1), version: z.number().int().positive(), kind: CapabilityKind,
    source_node_key: NodeKey, rationale: z.string().min(1), score: z.number().min(0).max(1), factors: z.record(z.string(), z.number()),
    required_connector: ConnectorTypeSchema.nullish(),
  }).strict()),
}).strict();

export const ArchitectureCompileInputSchema = z.object({
  tenant_id: z.string().regex(/^ten_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  workspace_id: z.string().regex(/^ws_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  workflow_id: z.string().regex(/^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  dag_schema_version: z.string().min(1),
  architecture: ArchitectureSpec,
  binding_decision: BindingDecision,
}).strict();
export type ArchitectureCompileInput = z.infer<typeof ArchitectureCompileInputSchema>;

function nodeType(node: z.infer<typeof ArchitectureNode>, binding: z.infer<typeof BindingDecision>["bindings"][number] | undefined): NodeType {
  if (node.execution_kind === "control") {
    // Both lowered to Gate before source_node_type existed. A join became a Gate
    // with no conditions, which GateHandler rejects, so every fan-in failed.
    if (node.source_node_type === "join") return "Merge";
    if (node.source_node_type === "branch") return "Gate";
    throw new CompilerValidationError(`control node "${node.source_node_key}" has no source_node_type: a branch and a join cannot be told apart`);
  }
  if (binding?.kind === "execution") return "SandboxExec";
  if (binding?.kind === "tool" || binding?.kind === "connector") return "ToolCall";
  // A deterministic node is an external action whether or not binding pinned a
  // record for it -- the resolver declares no capability for tool nodes, so it
  // usually has none. Lowering it to LLMTask sent its tool call to a model.
  if (node.execution_kind === "deterministic") return "ToolCall";
  return "LLMTask";
}

/** Pure lowering only. Legacy task-skeleton compilation remains separate until callers migrate. */
export function compileArchitectureToDag(raw: ArchitectureCompileInput): CompiledDag {
  const input = ArchitectureCompileInputSchema.safeParse(raw);
  if (!input.success) throw new CompilerValidationError(`invalid architecture compiler input: ${input.error.message}`);
  const { architecture, binding_decision: decision } = input.data;
  const byKey = new Map<string, z.infer<typeof ArchitectureNode>>();
  for (const node of architecture.nodes) {
    if (byKey.has(node.source_node_key)) throw new CompilerValidationError(`duplicate source node: ${node.source_node_key}`);
    byKey.set(node.source_node_key, node);
    const capabilityRole = node.capability_role;
    if (capabilityRole !== undefined && capabilityRole !== null && capabilityRole.source_node_key !== node.source_node_key) throw new CompilerValidationError(`capability role source-node mismatch: ${node.source_node_key}`);
  }
  const bindings = new Map<string, z.infer<typeof BindingDecision>["bindings"][number]>();
  for (const binding of decision.bindings) {
    if (bindings.has(binding.source_node_key)) throw new CompilerValidationError(`duplicate binding source node: ${binding.source_node_key}`);
    const node = byKey.get(binding.source_node_key);
    if (node === undefined || node.capability_role === null || node.capability_role === undefined) throw new CompilerValidationError(`binding/source-node mismatch: ${binding.source_node_key}`);
    if (!node.capability_role.eligible_kinds.includes(binding.kind)) throw new CompilerValidationError(`ineligible binding kind for ${binding.source_node_key}`);
    bindings.set(binding.source_node_key, binding);
  }
  for (const node of architecture.nodes) {
    if (node.depends_on.some((key) => !byKey.has(key))) throw new CompilerValidationError(`source-node dependency is unknown: ${node.source_node_key}`);
    if (node.capability_role !== null && node.capability_role !== undefined && !bindings.has(node.source_node_key)) throw new CompilerValidationError(`missing binding for required capability role: ${node.source_node_key}`);
  }
  const remaining = new Set(byKey.keys());
  const resolved = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) => (byKey.get(key)?.depends_on ?? []).every((dependency) => resolved.has(dependency)));
    if (ready.length === 0) throw new CompilerValidationError(`architecture contains cyclic dependencies: ${[...remaining].sort().join(", ")}`);
    ready.forEach((key) => { remaining.delete(key); resolved.add(key); });
  }
  const nodes: CompiledDag["nodes"] = architecture.nodes.map((node) => {
    const binding = bindings.get(node.source_node_key);
    // The node's own configuration first, then the binding's identifiers on
    // top -- binding metadata is chosen here and must win over anything a
    // skeleton happened to carry under the same keys.
    if (binding?.kind === "connector" && binding.required_connector == null) throw new CompilerValidationError(`connector binding needs required_connector: ${node.source_node_key}`);
    const bindingConfig = binding === undefined ? {} : {
      capability_record_id: binding.record_id, capability_version: binding.version,
      ...(binding.required_connector == null ? {} : { required_connector: binding.required_connector }),
    };
    return {
      key: node.source_node_key,
      type: nodeType(node, binding),
      config: { ...(node.config ?? {}), ...bindingConfig },
      ...(node.success_criteria === undefined || node.success_criteria === null
        ? {}
        : { success_criteria: node.success_criteria }),
      metadata: { ui: {} },
    };
  });
  // Branches route with CEL conditions keyed by successor, exactly as the
  // skeleton compiler lowers them; the compiled Gate carries that map so
  // GateHandler can evaluate it, and each successor edge is conditional.
  const branchConditions = new Map<string, Record<string, string>>();
  for (const node of architecture.nodes) {
    if (node.source_node_type !== "branch") continue;
    const key = node.source_node_key;
    const conditions = extractGateConditions(key, node.config ?? {});
    const successors = new Set(architecture.nodes.filter((candidate) => candidate.depends_on.includes(key)).map((candidate) => candidate.source_node_key));
    validateGateConditionCoverage(key, conditions, successors);
    branchConditions.set(key, conditions);
    const compiled = nodes.find((candidate) => candidate.key === key)!;
    compiled.config = { ...compiled.config, conditions };
  }
  const edges: CompiledDag["edges"] = architecture.nodes.flatMap((node) => node.depends_on.map((from): CompiledDag["edges"][number] => {
    const edgeKey = `${from}-to-${node.source_node_key}`;
    const conditions = branchConditions.get(from);
    if (conditions !== undefined) return { key: edgeKey, from, to: node.source_node_key, kind: "conditional", condition: { expression: conditions[node.source_node_key]!, language: "cel" } };
    return { key: edgeKey, from, to: node.source_node_key, kind: node.source_node_type === "join" ? "merge" : "sequential" };
  }));
  const addNode = (key: string, type: NodeType, config: Record<string, unknown>): void => {
    if (byKey.has(key) || nodes.some((node) => node.key === key)) throw new CompilerValidationError(`boundary node collides with an existing node: ${key}`);
    nodes.push({ key, type, config, metadata: { ui: {} } });
  };
  const pass = { expression: "true", language: "cel" as const };

  for (const boundary of architecture.boundaries) {
    const target = boundary.before_node_key ?? boundary.after_node_key;
    if (target == null || !byKey.has(target)) throw new CompilerValidationError(`boundary references unknown source node: ${target}`);
  }

  // Before a node: inputs -> [approval] -> verification gate chain -> node.
  // The node keeps its original input edges so its handler still receives
  // upstream outputs; the conditional edge from the last gate is what the
  // Executor checks before running it. One gate per input, chained, so every
  // input must pass: the Executor unlocks a node when ANY conditional
  // predecessor allows it, so parallel gates would let one passing input
  // release an action another input failed.
  for (const node of architecture.nodes) {
    const key = node.source_node_key;
    const before = architecture.boundaries.filter((boundary) => boundary.before_node_key === key);
    if (before.length === 0) continue;
    const approval = before.find((boundary) => boundary.kind === "human_approval");
    const verification = before.find((boundary) => boundary.kind === "verification");
    // A branch that routes to this node must decide whether the inserted steps
    // run at all. Its condition moves onto each step fed directly by the node's
    // inputs, and its edge into the node itself becomes plain input. Left as a
    // conditional edge into the node, the Executor's OR over conditional
    // predecessors would let a passing verification gate run a node the
    // branch routed away from.
    const routingBranches = node.depends_on.filter((from) => branchConditions.has(from));
    const plainInputs = node.depends_on.filter((from) => !branchConditions.has(from));
    const guard = (to: string): void => {
      for (const branch of routingBranches) {
        const conditions = branchConditions.get(branch)!;
        conditions[to] = conditions[key]!;
        edges.push({ key: `${branch}-to-${to}`, from: branch, to, kind: "conditional", condition: { expression: conditions[key]!, language: "cel" } });
      }
    };
    for (const branch of routingBranches) {
      const index = edges.findIndex((candidate) => candidate.from === branch && candidate.to === key);
      edges[index] = { key: edges[index]!.key, from: branch, to: key, kind: "sequential" };
    }
    let previous: string[] = plainInputs;
    if (approval !== undefined) {
      const approvalKey = `human_approval_before_${key}`;
      addNode(approvalKey, "HumanApproval", { requested_action: { kind: "run_node", node_key: key, reason: approval.reason } });
      previous.forEach((from) => edges.push({ key: `${from}-to-${approvalKey}`, from, to: approvalKey, kind: "sequential" }));
      guard(approvalKey);
      edges.push({ key: `${approvalKey}-to-${key}`, from: approvalKey, to: key, kind: "sequential" });
      previous = [approvalKey];
    }
    if (verification !== undefined) {
      if (node.depends_on.length === 0) {
        throw new CompilerValidationError(`External action "${key}" cannot be a source node: no upstream output exists to verify`);
      }
      const gateKeys = node.depends_on.map((_source, index) => `verification_before_${key}_${index}`);
      node.depends_on.forEach((source, index) => {
        const gateKey = gateKeys[index]!;
        const protectedKey = gateKeys[index + 1] ?? key;
        addNode(gateKey, "Gate", { verification: { source_node_key: source, protected_node_key: protectedKey, policy: "provisional-quality-pass-and-noncritical-safety" }, boundary: "verification", reason: verification.reason });
        if (index === 0) {
          previous.forEach((from) => edges.push({ key: `${from}-to-${gateKey}`, from, to: gateKey, kind: "sequential" }));
          guard(gateKey);
        }
        edges.push({ key: `${gateKey}-to-${protectedKey}`, from: gateKey, to: protectedKey, kind: "conditional", condition: pass });
      });
    }
  }
  // After a node: node -> [verification gate] -> [approval], for output the run delivers.
  for (const node of architecture.nodes) {
    const key = node.source_node_key;
    const after = architecture.boundaries.filter((boundary) => boundary.after_node_key === key);
    const verification = after.find((boundary) => boundary.kind === "verification");
    const approval = after.find((boundary) => boundary.kind === "human_approval");
    const gateKey = `verification_${key}`;
    const approvalKey = `human_approval_${key}`;
    if (verification !== undefined) {
      addNode(gateKey, "Gate", { verification: { source_node_key: key, protected_node_key: approval === undefined ? key : approvalKey, policy: "provisional-quality-pass-and-noncritical-safety" }, boundary: "verification", reason: verification.reason });
      edges.push({ key: `${key}-to-${gateKey}`, from: key, to: gateKey, kind: "sequential" });
    }
    if (approval !== undefined) {
      addNode(approvalKey, "HumanApproval", { requested_action: { kind: "deliver_output", node_key: key, reason: approval.reason } });
      edges.push(verification === undefined
        ? { key: `${key}-to-${approvalKey}`, from: key, to: approvalKey, kind: "sequential" }
        : { key: `${gateKey}-to-${approvalKey}`, from: gateKey, to: approvalKey, kind: "conditional", condition: pass });
    }
  }

  // Waves come from the lowered graph, not the architecture's source waves:
  // gates inserted before a node must run in a wave between its inputs and it.
  const waves = computeWaves(nodes, edges);
  const incoming = new Set(edges.map((edge) => edge.to));
  const entry = nodes.filter((node) => !incoming.has(node.key)).map((node) => node.key).sort();
  const result = CompiledDagSchema.safeParse({
    schema_version: input.data.dag_schema_version,
    entry_node_keys: entry,
    ...(architecture.success_criteria === undefined || architecture.success_criteria === null
      ? {}
      : { success_criteria: architecture.success_criteria }),
    nodes,
    edges,
    waves,
  });
  if (!result.success) throw new CompilerValidationError(`invalid architecture DAG: ${result.error.message}`);
  return result.data;
}
