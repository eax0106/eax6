import { z } from "./zod";
import { ConnectionSecretReferenceSchema, ConnectorTypeSchema } from "./connection-registry";
import { ModelAliasSchema } from "./model-alias-policy";
import { ToolNameSchema, hasExternalSideEffect } from "./tool-names";
import { DataContractSchema, NodeOverrideChoiceSchema, NodeOverrideSafeguardsSchema, NodeSelectionEvidenceSchema, dataContractFits } from "./node-overrides";
import {
  AgentIdSchema,
  ArtifactIdSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  PolicyIdSchema,
  TenantIdSchema,
  WorkflowIdSchema,
  WorkflowVersionIdSchema,
  WorkspaceIdSchema,
} from "./ids";

export const NodeTypeSchema = z.enum([
  "LLMTask",
  "ToolCall",
  "SandboxExec",
  "Gate",
  "HumanApproval",
  "Merge",
  "Synthesis",
  "MemoryWrite",
  "PubSub",
  "GroupChat",
  "YAMLImport",
]);

const NodeKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,127}$/i, {
    message: "Node keys must be stable graph-local identifiers",
  });
const EdgeKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,127}$/i);
const WaveKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,127}$/i);

/**
 * Canonical tenant integration secret reference. This is a reference ID,
 * never credential material. Integration identifiers remain opaque because
 * the documented path convention permits provider-owned names as well as
 * Alter-prefixed IDs.
 */
export const ToolCredentialReferenceSchema = NonEmptyStringSchema.superRefine(
  (reference, context) => {
    if (ConnectionSecretReferenceSchema.safeParse(reference).success) return;
    const segments = reference.split("/");
    const tenantId = segments[4];
    if (
      segments[0] !== "" ||
      segments.length !== 8 ||
      segments.slice(1).some((segment) => segment.trim().length === 0) ||
      segments[1] !== "alter" ||
      segments[2]?.trim().length === 0 ||
      segments[3] !== "tenant" ||
      tenantId === undefined ||
      !TenantIdSchema.safeParse(tenantId).success ||
      segments[5] !== "integration" ||
      segments[6]?.trim().length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Expected /alter/{env}/tenant/{tenant_id}/integration/{integration_id}/{secret_name}",
      });
    }
  },
).describe("Tenant integration secret reference ID; never secret material");

/**
 * Additive EXEC-3 view of ToolCall's compiled config. Fields stay optional at
 * schema-read time so previously compiled DAGs remain readable; ToolCall
 * execution fails closed when any required field is absent.
 */
export const ToolCallCompiledConfigSchema = z
  .object({
    tool_name: NonEmptyStringSchema.optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    credential_ref: ToolCredentialReferenceSchema.optional(),
    required_connector: ConnectorTypeSchema.optional(),
    expected_page_state: z
      .object({
        text: NonEmptyStringSchema.optional(),
        selector: NonEmptyStringSchema.optional(),
      })
      .strict()
      .refine((value) => value.text !== undefined || value.selector !== undefined, {
        message: "expected_page_state needs text or selector",
      })
      .optional(),
  })
  .passthrough();

/** Session ownership remains in Provisioning; Executor receives this opaque ID. */
export const SandboxExecCompiledConfigSchema = z
  .object({
    command: NonEmptyStringSchema.optional(),
    sandbox_session_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "sandbox_session_id must be an opaque non-empty session ID",
      })
      .optional(),
  })
  .passthrough();

/** References are supplied by the compiled node; MemoryWrite never invents them. */
export const MemoryWriteCompiledConfigSchema = z
  .object({
    workspace_id: WorkspaceIdSchema.optional(),
    verified_output_artifact_id: ArtifactIdSchema.optional(),
    namespace: NonEmptyStringSchema.optional(),
  })
  .passthrough();

const WorkflowDagNodeSchema = z
  .object({
    key: NodeKeySchema,
    type: NodeTypeSchema,
    config: z.record(z.string(), z.unknown()),
    success_criteria: z.array(NonEmptyStringSchema).min(1).optional(),
    metadata: z
      .object({
        ui: z.record(z.string(), z.unknown()),
        selection_binding: NodeSelectionEvidenceSchema.optional(),
        original_choice: NodeOverrideChoiceSchema.optional(),
        override_safeguards: NodeOverrideSafeguardsSchema.optional(),
        data_contract: z.object({
          output: DataContractSchema.optional(),
          inputs: z.record(NodeKeySchema, DataContractSchema).optional(),
        }).strict().optional(),
      })
      .passthrough(),
  })
  .strict()
  .superRefine(({ type, config }, context) => {
    for (const [field, nodeType, valueSchema, valueField] of [
      ["manual_model_override", "LLMTask", ModelAliasSchema, "model_alias"],
      ["manual_tool_override", "ToolCall", ToolNameSchema, "tool_name"],
    ] as const) {
      if (config[field] !== undefined && (config[field] !== true || type !== nodeType || !valueSchema.safeParse(config[valueField]).success)) {
        context.addIssue({code:"custom",message:`${field} requires ${nodeType} with a valid ${valueField}`,path:["config",field]});
      }
    }
    if (type !== "ToolCall" && type !== "SandboxExec" && type !== "MemoryWrite") {
      return;
    }
    const schema = type === "ToolCall"
      ? ToolCallCompiledConfigSchema
      : type === "SandboxExec"
        ? SandboxExecCompiledConfigSchema
        : MemoryWriteCompiledConfigSchema;
    const result = schema.safeParse(config);
    if (result.success) {
      return;
    }
    for (const issue of result.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["config", ...issue.path],
      });
    }
  });

const EdgeConditionSchema = z
  .object({
    expression: NonEmptyStringSchema,
    language: z.literal("cel"),
  })
  .strict();

const WorkflowDagEdgeSchema = z
  .object({
    key: EdgeKeySchema,
    from: NodeKeySchema,
    to: NodeKeySchema,
    kind: z.enum([
      "sequential",
      "conditional",
      "loop",
      "merge",
      "developer",
    ]),
    condition: EdgeConditionSchema.optional(),
    loop: z
      .object({
        max_iterations: z.number().int().positive(),
        exit_condition: EdgeConditionSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine(({ kind, condition, loop }, context) => {
    if (kind === "conditional" && condition === undefined) {
      context.addIssue({
        code: "custom",
        message: "Conditional edges require a condition",
        path: ["condition"],
      });
    }

    if (kind === "loop" && loop === undefined) {
      context.addIssue({
        code: "custom",
        message: "Loop edges require bounded loop configuration",
        path: ["loop"],
      });
    }
  });

const WorkflowDagWaveSchema = z
  .object({
    key: WaveKeySchema,
    order: z.number().int().nonnegative(),
    node_keys: z.array(NodeKeySchema).min(1),
    depends_on: z.array(WaveKeySchema),
  })
  .strict();

// ENGINE-FIX-P3-16b: nodes/edges had no upper bound -- a compiled DAG this
// large would serialize well past Temporal's workflow-input payload ceiling
// (default ~2MB gRPC message), failing opaquely deep in orchestration
// instead of at the schema boundary where the problem actually is. Bounds
// sized generously above any real workflow (edges capped higher than nodes
// since a DAG is commonly denser than 1:1).
const MAX_DAG_NODES = 1_000;
const MAX_DAG_EDGES = 4_000;

export const CompiledDagSchema = z
  .object({
    schema_version: NonEmptyStringSchema,
    entry_node_keys: z.array(NodeKeySchema).min(1),
    success_criteria: z.array(NonEmptyStringSchema).min(1).optional(),
    nodes: z.array(WorkflowDagNodeSchema).min(1).max(MAX_DAG_NODES),
    edges: z.array(WorkflowDagEdgeSchema).max(MAX_DAG_EDGES),
    waves: z.array(WorkflowDagWaveSchema).min(1),
  })
  .strict()
  .superRefine(({ entry_node_keys, nodes, edges, waves }, context) => {
    const nodeKeys = new Set(nodes.map(({ key }) => key));
    const waveKeys = new Set(waves.map(({ key }) => key));

    if (nodeKeys.size !== nodes.length) {
      context.addIssue({
        code: "custom",
        message: "Node keys must be unique",
        path: ["nodes"],
      });
    }

    if (waveKeys.size !== waves.length) {
      context.addIssue({
        code: "custom",
        message: "Wave keys must be unique",
        path: ["waves"],
      });
    }

    for (const [index, key] of entry_node_keys.entries()) {
      if (!nodeKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Entry node must reference an existing node",
          path: ["entry_node_keys", index],
        });
      }
    }

    for (const [index, edge] of edges.entries()) {
      if (!nodeKeys.has(edge.from) || !nodeKeys.has(edge.to)) {
        context.addIssue({
          code: "custom",
          message: "Edge endpoints must reference existing nodes",
          path: ["edges", index],
        });
      }
    }

    const assignedNodes = new Set<string>();
    for (const [waveIndex, wave] of waves.entries()) {
      for (const [nodeIndex, nodeKey] of wave.node_keys.entries()) {
        if (!nodeKeys.has(nodeKey) || assignedNodes.has(nodeKey)) {
          context.addIssue({
            code: "custom",
            message:
              "Every wave node must exist and may appear in exactly one wave",
            path: ["waves", waveIndex, "node_keys", nodeIndex],
          });
        }
        assignedNodes.add(nodeKey);
      }

      for (const [dependencyIndex, dependency] of wave.depends_on.entries()) {
        if (!waveKeys.has(dependency) || dependency === wave.key) {
          context.addIssue({
            code: "custom",
            message: "Wave dependencies must reference a different wave",
            path: ["waves", waveIndex, "depends_on", dependencyIndex],
          });
        }
      }
    }

    if (assignedNodes.size !== nodeKeys.size) {
      context.addIssue({
        code: "custom",
        message: "Every node must belong to exactly one execution wave",
        path: ["waves"],
      });
    }
    // Additive preflight for manual choices; legacy graphs keep their existing contract.
    if (!nodes.some(node => node.config.manual_model_override === true || node.config.manual_tool_override === true)) return;
    const outgoing = new Map(nodes.map(node => [node.key, [] as string[]]));
    const incoming = new Map(nodes.map(node => [node.key, 0]));
    for (const edge of edges) if (edge.kind !== "loop" && nodeKeys.has(edge.from) && nodeKeys.has(edge.to)) {
      outgoing.get(edge.from)!.push(edge.to);
      incoming.set(edge.to, incoming.get(edge.to)! + 1);
    }
    const ready = [...incoming].filter(([,count]) => count === 0).map(([key]) => key);
    let resolved = 0;
    for (let i = 0; i < ready.length; i++) {
      resolved++;
      for (const target of outgoing.get(ready[i]!) ?? []) {
        const count = incoming.get(target)! - 1; incoming.set(target,count);
        if (count === 0) ready.push(target);
      }
    }
    if (resolved !== nodeKeys.size) context.addIssue({code:"custom",message:"Manual graph contains a non-loop cycle",path:["edges"]});
    const reachable = new Set(entry_node_keys);
    const pending = [...entry_node_keys];
    for (let i = 0; i < pending.length; i++) for (const target of outgoing.get(pending[i]!) ?? []) if (!reachable.has(target)) {
      reachable.add(target); pending.push(target);
    }
    for (const node of nodes) if (!reachable.has(node.key)) context.addIssue({code:"custom",message:`Node is unreachable from declared entries: ${node.key}`,path:["nodes"]});
    const byKey = new Map(nodes.map(node => [node.key,node]));
    const waveOrder=new Map(waves.flatMap(wave=>wave.node_keys.map(key=>[key,wave.order] as const)));
    for (const edge of edges) if (edge.kind !== "loop" && (waveOrder.get(edge.from) ?? -1) >= (waveOrder.get(edge.to) ?? -1)) context.addIssue({code:"custom",message:`Execution waves must follow forward dependencies: ${edge.from} to ${edge.to}`,path:["waves"]});
    for (const node of nodes) {
      if (node.config.manual_tool_override !== true || !hasExternalSideEffect(String(node.config.tool_name))) continue;
      const conditions = edges.filter(edge => edge.to === node.key && edge.kind === "conditional");
      const gates = conditions.map(edge => byKey.get(edge.from));
      const verification=gates[0]?.config.verification as Record<string,unknown> | undefined;
      const guarded = gates.length === 1 && gates[0]?.type === "Gate" &&
        verification?.protected_node_key === node.key && verification?.policy === "provisional-quality-pass-and-noncritical-safety" &&
        typeof verification?.source_node_key === "string" && byKey.has(verification.source_node_key) && verification.source_node_key !== node.key;
      const approvals = nodes.filter(item => item.type === "HumanApproval" &&
        (item.config.requested_action as Record<string,unknown> | undefined)?.node_key === node.key);
      const gateKey = gates[0]?.key;
      const approved = gateKey !== undefined && approvals.some(approval => {
        const descendants = new Set([approval.key]);
        const queue = [approval.key];
        for (let i=0;i<queue.length;i++) for (const target of outgoing.get(queue[i]!) ?? []) if (!descendants.has(target) && target !== node.key) {
          descendants.add(target); queue.push(target);
        }
        return descendants.has(gateKey);
      });
      if (!guarded) context.addIssue({code:"custom",message:`Manual outside action needs its verification boundary: ${node.key}`,path:["nodes"]});
      if (node.metadata.override_safeguards?.approval_required !== false && !approved) context.addIssue({code:"custom",message:`Manual outside action needs its required approval boundary: ${node.key}`,path:["nodes"]});
    }
    for (const node of nodes) for (const [source, input] of Object.entries(node.metadata.data_contract?.inputs ?? {})) {
      if (!edges.some(edge => edge.from === source && edge.to === node.key)) {
        context.addIssue({code:"custom",message:`Input contract has no upstream edge: ${source} to ${node.key}`,path:["nodes"]});
        continue;
      }
      const output = byKey.get(source)?.metadata.data_contract?.output;
      if (output && !dataContractFits(output,input)) context.addIssue({code:"custom",message:`Output contract does not fit downstream input: ${source} to ${node.key}`,path:["nodes"]});
    }
  });

export const NodeRequirementSchema = z
  .object({
    capabilities: z.array(NonEmptyStringSchema),
    model_alias: z
      .enum(["FAST", "STANDARD", "ADVANCED", "CEILING"])
      .optional(),
    tools: z
      .array(
        z
          .object({
            name: NonEmptyStringSchema,
            version: NonEmptyStringSchema.optional(),
            permissions: z.array(NonEmptyStringSchema),
          })
          .strict(),
      )
      .optional(),
    preferred_agent_id: AgentIdSchema.optional(),
    maximum_input_bytes: z.number().int().positive().optional(),
  })
  .strict();

export const NodeRequirementsSchema = z.record(
  NodeKeySchema,
  NodeRequirementSchema,
);

export const PolicyBindingSchema = z
  .object({
    policy_id: PolicyIdSchema,
    version: NonEmptyStringSchema,
  })
  .strict();

export const PolicyBindingsSchema = z.record(
  NonEmptyStringSchema,
  PolicyBindingSchema,
);

const CompileMetadataSchema = z
  .object({
    compiler_version: NonEmptyStringSchema,
    source_skeleton_hash: NonEmptyStringSchema,
    compiled_at: IsoTimestampSchema,
    source_artifact_id: ArtifactIdSchema.optional(),
  })
  .strict();

export const WorkflowDagDraftSchema = z
  .object({
    status: z.literal("draft"),
    tenant_id: TenantIdSchema,
    workspace_id: WorkspaceIdSchema,
    workflow_id: WorkflowIdSchema,
    revision: z.number().int().nonnegative(),
    dag: CompiledDagSchema,
  })
  .strict();

export const WorkflowVersionStatusSchema = z.enum([
  "compiled",
  "tested",
  "canary",
  "promoted",
  "rolled_back",
  "retired",
]);

export const WorkflowDagCompiledSchema = z
  .object({
    id: WorkflowVersionIdSchema,
    tenant_id: TenantIdSchema,
    workflow_id: WorkflowIdSchema,
    version: z.number().int().positive(),
    compiled_dag: CompiledDagSchema,
    dag_schema_version: NonEmptyStringSchema,
    node_requirements: NodeRequirementsSchema.optional(),
    policy_bindings: PolicyBindingsSchema.optional(),
    compile_metadata: CompileMetadataSchema.optional(),
    status: WorkflowVersionStatusSchema,
  })
  .strict()
  .readonly();

export type NodeType = z.infer<typeof NodeTypeSchema>;
export type ToolCallCompiledConfig = z.infer<
  typeof ToolCallCompiledConfigSchema
>;
export type SandboxExecCompiledConfig = z.infer<
  typeof SandboxExecCompiledConfigSchema
>;
export type MemoryWriteCompiledConfig = z.infer<
  typeof MemoryWriteCompiledConfigSchema
>;
export type CompiledDag = z.infer<typeof CompiledDagSchema>;

/** The public caller's current workspace/workflow rules replace client metadata. */
export function withNodeOverrideSafeguards(dag:CompiledDag,approvalRequired:boolean):CompiledDag {
  return {...dag,nodes:dag.nodes.map(node=>{
    const metadata={...node.metadata}; delete metadata.override_safeguards;
    return {...node,metadata:{...metadata,...(node.config.manual_tool_override === true && hasExternalSideEffect(String(node.config.tool_name)) ? {override_safeguards:{approval_required:approvalRequired}} : {})}};
  })};
}
export type NodeRequirements = z.infer<typeof NodeRequirementsSchema>;
export type PolicyBindings = z.infer<typeof PolicyBindingsSchema>;
export type WorkflowDagDraft = z.infer<typeof WorkflowDagDraftSchema>;
export type WorkflowDagCompiled = z.infer<
  typeof WorkflowDagCompiledSchema
>;
