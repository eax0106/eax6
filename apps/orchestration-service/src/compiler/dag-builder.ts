/**
 * Graph Compiler core: bound Task Skeleton (Planner output, see
 * apps/intelligence-service/src/planner/task_skeleton.py) -> typed
 * CompiledDag (packages/contracts/src/workflow-dag.ts, the locked contract
 * every other Engine component reads).
 *
 * Pure and deterministic: given the same skeleton and schema version, always
 * produces the same DAG. No I/O here -- persistence/versioning lives in
 * graph-compiler.service.ts.
 */

import { z } from "zod";

import { CompiledDagSchema, type CompiledDag, type NodeType } from "@alterx/contracts";

import { MergeArithmeticConfigSchema } from "../registry/handlers/record-aggregation";

export class CompilerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompilerValidationError";
  }
}

const TaskSkeletonNodeSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/i),
    type: z.enum(["llm", "tool", "branch", "join"]),
    config: z.record(z.string(), z.unknown()),
    depends_on: z.array(z.string()),
    success_criteria: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

const TaskSkeletonSchema = z
  .object({
    version: z.string(),
    nodes: z.array(TaskSkeletonNodeSchema).min(1),
    entry_point: z.string(),
    success_criteria: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

export type TaskSkeleton = z.infer<typeof TaskSkeletonSchema>;
type TaskSkeletonNode = z.infer<typeof TaskSkeletonNodeSchema>;

// Planner emits 4 internal node kinds (see task_skeleton.py); the compiled
// DAG uses the full 11-type Node Type Registry vocabulary (doc 13 sec 2).
// This is the one place that maps between them.
const NODE_TYPE_MAP: Record<TaskSkeletonNode["type"], NodeType> = {
  llm: "LLMTask",
  tool: "ToolCall",
  branch: "Gate",
  join: "Merge",
};

export function parseTaskSkeleton(taskSkeletonJson: string): TaskSkeleton {
  let raw: unknown;
  try {
    raw = JSON.parse(taskSkeletonJson);
  } catch (error: unknown) {
    throw new CompilerValidationError(
      `task_skeleton_json is not valid JSON: ${(error as Error).message}`,
    );
  }

  const result = TaskSkeletonSchema.safeParse(raw);
  if (!result.success) {
    throw new CompilerValidationError(
      `task_skeleton_json does not match the expected TaskSkeleton shape: ${result.error.message}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// metadata.ui pocket helpers
// ---------------------------------------------------------------------------

// Reserved key prefix -- values starting with "$" are Platform-internal and
// must never appear in user-supplied metadata_ui.
const RESERVED_UI_KEY_PREFIX = "$";

function extractUiMetadata(
  nodeKey: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const raw = config["metadata_ui"];
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CompilerValidationError(
      `Node "${nodeKey}": config.metadata_ui must be a plain object`,
    );
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (key.startsWith(RESERVED_UI_KEY_PREFIX)) {
      throw new CompilerValidationError(
        `Node "${nodeKey}": config.metadata_ui key "${key}" uses the reserved prefix "$"`,
      );
    }
  }
  return raw as Record<string, unknown>;
}

// Strip the metadata_ui key from config before passing it to the compiled
// node's config field -- UI hints belong in metadata.ui, not in execution config.
function configWithoutUiMetadata(config: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== "metadata_ui") {
      rest[key] = value;
    }
  }
  return rest;
}

// ---------------------------------------------------------------------------
// Conditional edge helpers (Gate / branch nodes)
// ---------------------------------------------------------------------------

export function extractGateConditions(
  gateKey: string,
  config: Record<string, unknown>,
): Record<string, string> {
  const raw = config["conditions"];
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new CompilerValidationError(
      `Gate node "${gateKey}": config.conditions must be a plain object`,
    );
  }
  const conditions: Record<string, string> = {};
  for (const [targetKey, expr] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof expr !== "string" || expr.trim() === "") {
      throw new CompilerValidationError(
        `Gate node "${gateKey}": condition for target "${targetKey}" must be a non-empty string`,
      );
    }
    conditions[targetKey] = expr;
  }
  return conditions;
}

export function validateGateConditionCoverage(
  gateKey: string,
  conditions: Record<string, string>,
  successors: Set<string>,
): void {
  // Every successor must have a condition.
  for (const successorKey of successors) {
    if (!(successorKey in conditions)) {
      throw new CompilerValidationError(
        `Gate node "${gateKey}": no condition defined for successor "${successorKey}"`,
      );
    }
  }
  // Every condition key must reference an actual successor.
  for (const conditionKey of Object.keys(conditions)) {
    if (!successors.has(conditionKey)) {
      throw new CompilerValidationError(
        `Gate node "${gateKey}": condition references "${conditionKey}" which is not a direct successor`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main compilation entry point
// ---------------------------------------------------------------------------

export function compileTaskSkeletonToDag(
  skeleton: TaskSkeleton,
  dagSchemaVersion: string,
): CompiledDag {
  const nodesByKey = new Map<string, TaskSkeletonNode>();
  for (const node of skeleton.nodes) {
    if (nodesByKey.has(node.key)) {
      throw new CompilerValidationError(`Duplicate node key in skeleton: ${node.key}`);
    }
    if (node.type === "join" && !MergeArithmeticConfigSchema.safeParse(node.config).success) {
      throw new CompilerValidationError(`Node "${node.key}": invalid Merge arithmetic configuration`);
    }
    nodesByKey.set(node.key, node);
  }

  const entryNode = nodesByKey.get(skeleton.entry_point);
  if (entryNode === undefined) {
    throw new CompilerValidationError(
      `entry_point "${skeleton.entry_point}" does not reference a node in the skeleton`,
    );
  }
  if (entryNode.depends_on.length > 0) {
    throw new CompilerValidationError(
      `entry_point node "${skeleton.entry_point}" must not depend on any other node`,
    );
  }

  for (const node of skeleton.nodes) {
    for (const dependency of node.depends_on) {
      if (!nodesByKey.has(dependency)) {
        throw new CompilerValidationError(
          `Node "${node.key}" depends_on unknown node "${dependency}"`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Gather Gate successors and validate condition coverage up front so
  // we fail early before writing any compiled output.
  // ------------------------------------------------------------------

  const gateSuccessors = new Map<string, Set<string>>();
  for (const node of skeleton.nodes) {
    if (NODE_TYPE_MAP[node.type] === "Gate") {
      gateSuccessors.set(node.key, new Set());
    }
  }
  for (const node of skeleton.nodes) {
    for (const dep of node.depends_on) {
      const depNode = nodesByKey.get(dep);
      if (depNode !== undefined && NODE_TYPE_MAP[depNode.type] === "Gate") {
        gateSuccessors.get(dep)?.add(node.key);
      }
    }
  }

  const gateConditionsMap = new Map<string, Record<string, string>>();
  for (const [gateKey, successors] of gateSuccessors) {
    const gateNode = nodesByKey.get(gateKey);
    const conditions = extractGateConditions(gateKey, gateNode?.config ?? {});
    validateGateConditionCoverage(gateKey, conditions, successors);
    gateConditionsMap.set(gateKey, conditions);
  }

  // ------------------------------------------------------------------
  // Build compiled nodes (with metadata.ui pocket extraction).
  // ------------------------------------------------------------------

  const nodes: CompiledDag["nodes"] = skeleton.nodes.map((node) => ({
    key: node.key,
    type: NODE_TYPE_MAP[node.type],
    config: configWithoutUiMetadata(node.config),
    ...(node.success_criteria === undefined ? {} : { success_criteria: node.success_criteria }),
    metadata: { ui: extractUiMetadata(node.key, node.config) },
  }));

  // ------------------------------------------------------------------
  // Build compiled edges (conditional edges for Gate outputs).
  // ------------------------------------------------------------------

  const edges: CompiledDag["edges"] = [];
  for (const node of skeleton.nodes) {
    const nodeType = NODE_TYPE_MAP[node.type];
    const defaultKind = nodeType === "Merge" ? "merge" : "sequential";

    for (const dependency of node.depends_on) {
      const depNode = nodesByKey.get(dependency);
      const depType = depNode !== undefined ? NODE_TYPE_MAP[depNode.type] : undefined;

      if (depType === "Gate") {
        const expression = gateConditionsMap.get(dependency)?.[node.key] ?? "";
        edges.push({
          key: `${dependency}-to-${node.key}`,
          from: dependency,
          to: node.key,
          kind: "conditional",
          condition: { expression, language: "cel" },
        });
      } else {
        edges.push({
          key: `${dependency}-to-${node.key}`,
          from: dependency,
          to: node.key,
          kind: defaultKind,
        });
      }
    }
  }

  injectVerificationGates(nodes, edges, skeleton.entry_point);
  const waves = computeWaves(nodes, edges);

  const dag: CompiledDag = {
    schema_version: dagSchemaVersion,
    entry_node_keys: [skeleton.entry_point],
    ...(skeleton.success_criteria === undefined
      ? {}
      : { success_criteria: skeleton.success_criteria }),
    nodes,
    edges,
    waves,
  };

  // Belt-and-braces: the DAG we just built must satisfy the same contract
  // every other Engine component reads. A failure here is a compiler bug,
  // not a caller input error -- never persist or return a DAG that doesn't
  // pass its own schema.
  const validated = CompiledDagSchema.safeParse(dag);
  if (!validated.success) {
    throw new Error(
      `Graph Compiler produced a CompiledDag that fails its own schema: ${validated.error.message}`,
    );
  }
  return validated.data;
}

/**
 * Every ToolCall/SandboxExec requires a preceding result to verify. A source
 * external action therefore has no safe edge and is rejected rather than
 * silently bypassing the verification law.
 *
 * One verification gate per incoming edge, chained, with the last gate's
 * conditional edge the only condition on the action. The Executor unlocks a
 * node when ANY conditional predecessor allows it, so gates side by side would
 * let one verified input release an action another input failed, and a branch
 * that routed away would be overruled by a passing gate.
 *
 * A branch feeding the action decides whether the chain runs at all: its
 * condition for the action is copied onto the first gate, under that gate's
 * key. GateHandler reports activeSuccessors by condition key, so a branch
 * condition left keyed by the action would never name the gate that now sits
 * in between, and the action could never run.
 */
function injectVerificationGates(
  nodes: CompiledDag["nodes"],
  edges: CompiledDag["edges"],
  entryPoint: string,
): void {
  const externalActions = nodes.filter((node) => node.type === "ToolCall" || node.type === "SandboxExec");
  let gateIndex = 0;
  for (const action of externalActions) {
    const incoming = edges.filter((edge) => edge.to === action.key);
    if (incoming.length === 0) {
      const entryHint = action.key === entryPoint ? " entry point" : "";
      throw new CompilerValidationError(
        `External action "${action.key}" cannot be a${entryHint} source node: no upstream output exists to verify`,
      );
    }
    const gateKeys = incoming.map(() => `verify_step_${gateIndex++}`);
    const replacement: CompiledDag["edges"] = [];
    for (const edge of incoming) {
      if (edge.kind === "conditional") {
        // A branch routing to the action now routes to the head of its chain.
        const branch = nodes.find((node) => node.key === edge.from)!;
        const conditions = branch.config["conditions"] as Record<string, string>;
        branch.config = { ...branch.config, conditions: { ...conditions, [gateKeys[0]!]: conditions[action.key]! } };
        replacement.push({ ...edge, key: `${edge.from}-to-${gateKeys[0]}`, to: gateKeys[0]! });
      } else {
        replacement.push({ key: `${edge.from}-to-${gateKeys[0]}`, from: edge.from, to: gateKeys[0]!, kind: "sequential" });
      }
    }
    incoming.forEach((edge, index) => {
      const gateKey = gateKeys[index]!;
      const protectedKey = gateKeys[index + 1] ?? action.key;
      nodes.push({
        key: gateKey,
        type: "Gate",
        config: {
          verification: {
            source_node_key: edge.from,
            protected_node_key: protectedKey,
            policy: "provisional-quality-pass-and-noncritical-safety",
          },
        },
        metadata: { ui: {} },
      });
      replacement.push({
        key: `${gateKey}-to-${protectedKey}`,
        from: gateKey,
        to: protectedKey,
        kind: "conditional",
        condition: { expression: "true", language: "cel" },
      });
    });
    // Plain inputs also stay wired into the action, as the architecture
    // compiler does, so its handler still receives their outputs (a ToolCall
    // argument can reference them). Being sequential, they never unlock it:
    // the Executor gates a node only on its conditional predecessors.
    replacement.push(...incoming.filter((edge) => edge.kind !== "conditional"));
    // Replace the action's incoming edges in place, keeping edge order stable.
    const first = edges.indexOf(incoming[0]!);
    for (const edge of incoming.slice(1)) edges.splice(edges.indexOf(edge), 1);
    edges.splice(first, 1, ...replacement);
  }
}

export function computeWaves(
  nodes: CompiledDag["nodes"],
  edges: CompiledDag["edges"],
): CompiledDag["waves"] {
  const dependencies = new Map(nodes.map((node) => [node.key, new Set<string>()]));
  for (const edge of edges) dependencies.get(edge.to)?.add(edge.from);
  const waveIndexByNode = new Map<string, number>();
  const remaining = new Set(nodes.map((node) => node.key));
  let waveIndex = 0;

  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) => {
      return [...(dependencies.get(key) ?? [])].every((dep) => waveIndexByNode.has(dep));
    });

    if (ready.length === 0) {
      throw new CompilerValidationError(
        `Skeleton contains a dependency cycle among: ${[...remaining].sort().join(", ")}`,
      );
    }

    for (const key of ready) {
      waveIndexByNode.set(key, waveIndex);
      remaining.delete(key);
    }
    waveIndex += 1;
  }

  const waveCount = waveIndex;
  const waves: CompiledDag["waves"] = [];
  for (let index = 0; index < waveCount; index += 1) {
    const nodeKeys = [...waveIndexByNode.entries()]
      .filter(([, wave]) => wave === index)
      .map(([key]) => key)
      .sort();

    const dependsOnWaveIndexes = new Set<number>();
    for (const key of nodeKeys) {
      for (const dependency of dependencies.get(key) ?? []) {
        const dependencyWave = waveIndexByNode.get(dependency);
        if (dependencyWave !== undefined) {
          dependsOnWaveIndexes.add(dependencyWave);
        }
      }
    }

    waves.push({
      key: `wave_${index}`,
      order: index,
      node_keys: nodeKeys,
      depends_on: [...dependsOnWaveIndexes].sort((a, b) => a - b).map((i) => `wave_${i}`),
    });
  }
  return waves;
}
