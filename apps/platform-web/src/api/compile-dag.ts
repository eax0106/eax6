import type { CompiledDag } from "@alterx/contracts"

// Presentation-only grouping for the 11 canonical node types, mirroring
// orchestration-service's node-type-catalog.ts categories. Not sent to or
// read from the engine -- used locally so a loaded DAG's nodes get a
// sensible icon/category without an extra round-trip to fetch the catalog.
const NODE_TYPE_CATEGORY: Record<string, string> = {
  LLMTask: "execution",
  ToolCall: "execution",
  SandboxExec: "execution",
  Gate: "control-flow",
  Merge: "control-flow",
  HumanApproval: "human-in-the-loop",
  Synthesis: "output",
  MemoryWrite: "knowledge",
  PubSub: "collaboration",
  GroupChat: "collaboration",
  YAMLImport: "import",
}

export class WorkflowGraphCycleError extends Error {
  readonly nodeIds: readonly string[]
  readonly nodeNames: readonly string[]

  constructor(nodeIds: readonly string[], nodeNames: readonly string[]) {
    super(`Workflow contains a cycle among: ${nodeNames.join(", ")}`)
    this.name = "WorkflowGraphCycleError"
    this.nodeIds = nodeIds
    this.nodeNames = nodeNames
  }
}

function findCycleNodeIds(nodes: any[], edges: any[]): string[] {
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) outgoing.set(node.id, [])
  for (const edge of edges) {
    if (edge.data?.kind === "loop") continue
    if (outgoing.has(edge.source) && outgoing.has(edge.target)) {
      outgoing.get(edge.source)!.push(edge.target)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const cycleNodeIds = new Set<string>()
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      const start = stack.indexOf(nodeId)
      for (const cycleNodeId of stack.slice(start)) cycleNodeIds.add(cycleNodeId)
      return
    }
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    stack.push(nodeId)
    for (const target of outgoing.get(nodeId) ?? []) visit(target)
    stack.pop()
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const node of nodes) visit(node.id)
  return [...cycleNodeIds].sort()
}

export function compileDag(nodes: any[], edges: any[], successCriteria?: string[]): CompiledDag {
  const cycleNodeIds = findCycleNodeIds(nodes, edges)
  if (cycleNodeIds.length > 0) {
    const labels = new Map(nodes.map((node) => [node.id, node.data?.label ?? node.id]))
    throw new WorkflowGraphCycleError(
      cycleNodeIds,
      cycleNodeIds.map((nodeId) => labels.get(nodeId) ?? nodeId),
    )
  }
  const compiledNodes = nodes.map((node) => {
    // Basic mapping from UI node to backend node format
    const type = node.type === "humanApproval" ? "HumanApproval" : node.type

    // Inspector writes edited config fields flat onto node.data (see
    // inspector.tsx's updateNodeData calls), not nested under node.data.config.
    // Read both: flat fields (the real path) win over any legacy nested config.
    const { label: _label, category: _category, status: _status, successCriteria: _criteria, engineMetadata, config: nestedConfig, ...flatConfig } =
      (node.data ?? {}) as Record<string, unknown>
    let config: Record<string, unknown> = {
      ...(nestedConfig as Record<string, unknown> | undefined),
      ...flatConfig,
    }

    if (type === "HumanApproval") {
      // Ensure requested_action is nested properly or flattened based on what handler expects
      // The handler checks config["requested_action"] or falls back to entire config
      config = {
        ...config,
        requested_action: node.data?.requested_action ?? {
          title: node.data?.title ?? "Pending Approval",
          description: node.data?.description ?? "Please review this action",
          ...config,
        },
        expiry_seconds: node.data?.expiry_seconds ?? node.data?.expirySeconds ?? 86400,
      }
    }

    return {
      key: node.id,
      type: type,
      config: config,
      ...(node.data?.successCriteria?.length ? { success_criteria: node.data.successCriteria } : {}),
      metadata: {
        ...(engineMetadata as Record<string, unknown> | undefined),
        ui: {
          position: node.position,
          label: node.data?.label,
        },
      },
    }
  })

  const compiledEdges = edges.map((edge) => {
    return {
      key: edge.id,
      from: edge.source,
      to: edge.target,
      kind: edge.label === "conditional" ? ("conditional" as const) : edge.data?.kind ?? ("sequential" as const),
      ...(edge.label === "conditional"
        ? { condition: { expression: edge.data?.condition || "true", language: "cel" as const } }
        : {}),
      ...(edge.data?.loop ? { loop: edge.data.loop } : {}),
    }
  })

  // Determine entry nodes (nodes without incoming edges)
  const targets = new Set(edges.filter(e => e.data?.kind !== "loop").map((e) => e.target))
  const entryNodes = nodes.filter((n) => !targets.has(n.id)).map((n) => n.id)

  // Determine waves (simple topological sort for a DAG)
  const waves: any[] = []
  let currentWave = [...entryNodes]
  let currentOrder = 0
  let unassignedNodes = new Set(nodes.map(n => n.id))

  while (currentWave.length > 0 && unassignedNodes.size > 0) {
    const waveKey = `wave_${currentOrder}`
    waves.push({
      key: waveKey,
      order: currentOrder,
      node_keys: [...currentWave],
      depends_on: currentOrder > 0 ? [`wave_${currentOrder - 1}`] : [],
    })

    currentWave.forEach(k => unassignedNodes.delete(k))
    currentOrder++

    // A fan-in waits for every forward dependency, including longer branches.
    currentWave = [...unassignedNodes].filter(key => compiledEdges.filter(edge => edge.to === key && edge.kind !== "loop")
      .every(edge => !unassignedNodes.has(edge.from)))
  }

  if (unassignedNodes.size > 0) {
    waves.push({
      key: `wave_${currentOrder}`,
      order: currentOrder,
      node_keys: Array.from(unassignedNodes),
      depends_on: currentOrder > 0 ? [`wave_${currentOrder - 1}`] : [],
    })
  }

  return {
    schema_version: "v1",
    ...(successCriteria?.length ? { success_criteria: successCriteria } : {}),
    entry_node_keys: entryNodes.length > 0 ? entryNodes : [nodes[0]?.id].filter(Boolean),
    nodes: compiledNodes,
    edges: compiledEdges,
    waves: waves.length > 0 ? waves : [
      { key: "wave_0", order: 0, node_keys: nodes.map(n => n.id), depends_on: [] }
    ],
  }
}

/** Inverse of compileDag: a loaded CompiledDag back into canvas nodes/edges. */
export function dagToCanvas(dag: CompiledDag): { nodes: any[]; edges: any[] } {
  const nodes = dag.nodes.map((node) => {
    const ui = (node.metadata?.ui ?? {}) as { position?: { x: number; y: number }; label?: string }
    return {
      id: node.key,
      type: node.type,
      position: ui.position ?? { x: 0, y: 0 },
      data: {
        label: ui.label ?? node.key,
        category: NODE_TYPE_CATEGORY[node.type] ?? node.type,
        ...node.config,
        successCriteria: node.success_criteria,
        engineMetadata: node.metadata,
      },
    }
  })

  const edges = dag.edges.map((edge) => ({
    id: edge.key,
    source: edge.from,
    target: edge.to,
    label: edge.kind === "conditional" ? "conditional" : undefined,
    data: { kind: edge.kind, ...(edge.condition ? { condition: edge.condition.expression } : {}), ...(edge.loop ? { loop: edge.loop } : {}) },
  }))

  return { nodes, edges }
}
