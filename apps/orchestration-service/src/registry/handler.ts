import type { NodeType } from "@alterx/contracts";

/**
 * Shared contract every Node Type Registry handler implements. The
 * (future, not-yet-built) Executor calls execute() once per node visited
 * during a run wave; this ticket only builds the handlers themselves,
 * standalone and unit-tested -- wiring them into a live run is Executor's
 * job in a later Execution-phase ticket.
 */

export class NodeHandlerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeHandlerValidationError";
  }
}

export interface NodeExecutionContext {
  /** This node's compiled config (CompiledDag node.config). */
  readonly config: Record<string, unknown>;
  /** Upstream node outputs, keyed by the producing node's key. */
  readonly inputs: Record<string, Record<string, unknown>>;
  /**
   * Run identifiers, needed only by handlers that call a gateway
   * (Model Gateway, Tool Gateway) on the run's behalf. Optional so
   * EXEC-1's non-gateway handlers (Gate/Merge/PubSub/GroupChat/YAMLImport)
   * and their existing tests are unaffected -- added in EXEC-2 for
   * LLMTaskHandler.
   */
  readonly tenant_id?: string; // ten_ prefixed UUIDv7
  readonly run_id?: string; // run_ prefixed UUIDv7
  readonly node_execution_id?: string; // node_ prefixed UUIDv7
  /** Opaque cycle-scoped session ID supplied by Provisioning in node config. */
  readonly sandbox_session_id?: string;
  /**
   * Real Selection & Binding ranked-match result, resolved fresh by
   * Nodeexec immediately before execution (not baked in at compile time --
   * same runtime-injection shape as sandbox_session_id above, so a rebound
   * agent is picked up by the very next retry without recompiling the
   * workflow). Absent whenever no capabilityResolver/selectionBinding is
   * configured, or the ranked-match found no eligible agent -- callers
   * fall back to their own compiled config in that case, never treat a
   * missing binding as an error.
   */
  readonly agent_id?: string;
  readonly bound_model_alias?: string;
  readonly bound_tool_names?: readonly string[];
  /** The bound agent version's instructions (agent_versions.persona_description). */
  readonly bound_agent_instructions?: string;
  /**
   * C29: this node's own success criteria from the compiled DAG (design log
   * §5.1) -- what the task asked this node to achieve. Absent for workflows
   * compiled before criteria existed. The Verification & Quality Gate judges
   * the output against the same list.
   */
  readonly success_criteria?: readonly string[];
  /** Durable SSE publisher injected by Nodeexec; never exposed to workflow code. */
  readonly on_model_delta?: (delta: string, index: number, final: boolean) => Promise<void>;
}

export interface NodeExecutionResult {
  readonly output: Record<string, unknown>;
  /** Cross-cutting metadata (cost/usage, resolved capability, ...), not part of the node's actual output. */
  readonly metadata?: Record<string, unknown>;
}

export interface NodeHandler {
  readonly nodeType: NodeType;
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}
