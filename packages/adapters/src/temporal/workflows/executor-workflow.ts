import {
  ApplicationFailure,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  uuid4,
} from "@temporalio/workflow";

import { CompiledDagSchema, type CompiledDag } from "@alterx/contracts";

import type { ExecutorActivities } from "../activities/executor-activities";

export interface ExecutorWorkflowInput {
  readonly tenantId: string; // ten_ prefixed UUIDv7
  readonly runId: string; // run_ prefixed UUIDv7
  readonly compiledDagJson: string;
  /** Defaults to NODE_RECOVERY_TIMEOUT_MS; overridable for tests. */
  readonly nodeRecoveryTimeoutMs?: number;
}

export interface ExecutorWorkflowResult {
  /** Every node's output, keyed by node key. */
  readonly outputs: Record<string, Record<string, unknown>>;
}

export interface ApprovalDecisionSignal {
  readonly nodeExecutionId: string; // node_ prefixed UUIDv7
  readonly approved: boolean;
  readonly note?: string;
}

/**
 * Durable pause point for HumanApproval nodes (HEAL-7). Sent by the
 * /approvals REST API's approve/reject actions. Signals are persisted in
 * Temporal's workflow history -- a worker restart between the pending
 * ExecuteNode call and this signal arriving loses nothing; the workflow
 * replays and resumes its condition() wait exactly where it left off.
 */
export const approvalDecidedSignal = defineSignal<[ApprovalDecisionSignal]>(
  "approvalDecided",
);

export interface NodeRetryDecision {
  readonly nodeExecutionId: string; // node_ prefixed UUIDv7
  readonly action: "retry" | "give_up";
}

/**
 * Durable pause point for a genuinely failed node (Self-Healing exit-check
 * closure -- retry/backoff strategies). Sent by RecoveryDispatchService
 * once HEAL-6's policy table selects `retry` or `backoff` for this node's
 * failure. Mirrors approvalDecidedSignal's exact pattern: the workflow's
 * condition() wait survives a worker restart, replayed from Temporal
 * history, same as every other durable pause in this file.
 */
export const nodeRetryDecidedSignal = defineSignal<[NodeRetryDecision]>(
  "nodeRetryDecided",
);

/**
 * Unlike HumanApproval, a failed node has no natural expiry of its own --
 * this reuses HEAL-6's ask_user approval-expiry convention (86400s) for
 * consistency rather than inventing an unrelated number.
 */
const NODE_RECOVERY_TIMEOUT_MS = 86_400_000;

const EXECUTOR_WORKFLOW_VALIDATION_ERROR_TYPE = "ExecutorWorkflowValidationError";
const HUMAN_APPROVAL_REJECTED_ERROR_TYPE = "HumanApprovalRejectedError";
const HUMAN_APPROVAL_EXPIRED_ERROR_TYPE = "HumanApprovalExpiredError";
const NODE_RECOVERY_GIVEN_UP_ERROR_TYPE = "NodeRecoveryGivenUpError";
const NODE_RECOVERY_TIMED_OUT_ERROR_TYPE = "NodeRecoveryTimedOutError";
const SAFETY_VIOLATION_HALT_ERROR_TYPE = "SafetyViolationHaltError";

/** The activity's own non-retryable type (executor-activities.ts), under its ActivityFailure. */
function isSafetyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof ApplicationFailure && current.type === "SafetyViolation") return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/**
 * A plain `throw new Error(...)` inside workflow code is treated by
 * Temporal as a *workflow task* failure, not a workflow failure -- the
 * SDK retries the task indefinitely with backoff, which for a permanent
 * validation problem (bad DAG JSON) means silently burning worker compute
 * forever instead of ever surfacing to the caller. ApplicationFailure.
 * nonRetryable is the only way to make a workflow-code throw actually
 * fail the workflow (visible via handle.result() rejecting).
 */
function validationFailure(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    message,
    EXECUTOR_WORKFLOW_VALIDATION_ERROR_TYPE,
  );
}

const { executeNode, finalizeRun, recordApprovalDecision } = proxyActivities<ExecutorActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    // A handler validation/unimplemented-type failure will never succeed on
    // retry -- this is deliberately small (no Recovery Policy Engine exists
    // yet, that's Self-Healing phase). A transient gRPC hiccup gets 3 tries;
    // anything else fails the workflow, which is the correct "core" behavior
    // until real recovery strategies land.
    maximumAttempts: 3,
  },
});

function nodeExecutionId(): string {
  // Same version-nibble-patch technique already used elsewhere in this
  // codebase (e.g. trigger-registry.controller.ts's prefixedUuidV7) --
  // uuid4() here is Temporal's deterministic-replay-safe generator, not
  // Node's crypto.randomUUID(), which workflow code may never call directly.
  const id = uuid4();
  return `node_${id.slice(0, 14)}7${id.slice(15)}`;
}

function directPredecessorKeys(dag: CompiledDag, nodeKey: string): string[] {
  return dag.edges.filter((edge) => edge.to === nodeKey).map((edge) => edge.from);
}

function orderedWaves(dag: CompiledDag): CompiledDag["waves"] {
  return [...dag.waves].sort((a, b) => a.order - b.order);
}

/**
 * Real enforcement of "verification precedes every external action"
 * (HEAL-4) -- found missing entirely during Self-Healing exit-check
 * closure: the Graph Compiler (Planning phase) already encodes Gate
 * decisions as `kind: "conditional"` edges, but until this fix nothing
 * in the Executor ever read them. Every node in a wave executed
 * unconditionally regardless of what any guarding Gate decided.
 *
 * Deliberately reuses the Gate handler's own already-computed
 * `activeSuccessors` output (real, already correct -- see
 * gate.handler.ts) rather than re-evaluating CEL conditions inside
 * workflow code. A node is gated off only if it has at least one
 * incoming conditional edge AND none of them were satisfied (OR
 * semantics across multiple conditional predecessors, matching how
 * independent Gates can each unlock a shared downstream node).
 */
function isNodeGatedOff(
  dag: CompiledDag,
  nodeKey: string,
  outputs: Record<string, Record<string, unknown>>,
): boolean {
  const incomingConditional = dag.edges.filter(
    (edge) => edge.to === nodeKey && edge.kind === "conditional",
  );
  if (incomingConditional.length === 0) return false;

  for (const edge of incomingConditional) {
    const sourceOutput = outputs[edge.from];
    const activeSuccessors = sourceOutput?.["activeSuccessors"];
    if (Array.isArray(activeSuccessors) && activeSuccessors.includes(nodeKey)) {
      return false;
    }
  }
  return true;
}

function gatedOffOutput(gateNodeKeys: readonly string[]): Record<string, unknown> {
  return {
    skipped: true,
    // isNodeGatedOff only inspects edges of kind "conditional", so reaching
    // here always means a Gate's routing conditions were not satisfied --
    // never a verification failure. Gate's verification mode reports itself
    // separately, as verification_status "blocked_pending_recovery" with a
    // blocked_successor. Naming this one after verification sent anyone
    // auditing a skipped branch to look at quality gates instead of at the
    // condition that actually excluded it.
    reason: "gated_off_by_condition",
    gate_node_keys: gateNodeKeys,
  };
}

/**
 * Serializable failure summary for the finalizeRun activity -- never the
 * raw Error/ApplicationFailure object (workflow code must only pass
 * deterministic, JSON-safe values to activities), never a stack trace or
 * vendor internal (RFC 9457 discipline applies here too).
 */
function errorSummaryJson(error: unknown): string {
  if (error instanceof ApplicationFailure) {
    return JSON.stringify({ name: error.type ?? error.name, message: error.message });
  }
  if (error instanceof Error) {
    return JSON.stringify({ name: error.name, message: error.message });
  }
  return JSON.stringify({ name: "UnknownError", message: "Executor workflow failed" });
}

/**
 * Calls executeNode for one node, and on a genuine activity failure
 * (already recorded as node_executions.status='failed' by
 * NodeexecService's own catch-and-rethrow before this ever sees it),
 * pauses instead of propagating immediately -- mirroring
 * awaitApprovalDecision's exact condition()-wait shape, but for a failed
 * node awaiting a recovery decision (HEAL-6's retry/backoff strategies)
 * rather than an approval. Known gap, disclosed: a node whose handler
 * returns a ProblemDetails-shaped "soft failure" (status >= 400) without
 * throwing is NOT covered by this -- that path returns normally today and
 * is a separate, not-yet-fixed instance of the same class of bug the Gate
 * enforcement fix closed. Only genuine thrown/exhausted-retry activity
 * failures pause here.
 */
async function executeNodeWithRecovery(
  input: ExecutorWorkflowInput,
  node: CompiledDag["nodes"][number],
  predecessorKeys: readonly string[],
  approvalDecisions: Map<string, ApprovalDecisionSignal>,
  nodeRetryDecisions: Map<string, NodeRetryDecision>,
): Promise<Record<string, unknown>> {
  const nodeExecId = nodeExecutionId();
  try {
    const result = await executeNode({
      tenantId: input.tenantId,
      runId: input.runId,
      nodeExecutionId: nodeExecId,
      nodeKey: node.key,
      nodeType: node.type,
      configJson: JSON.stringify(node.config),
      predecessorKeys: [...predecessorKeys],
      ...(node.success_criteria === undefined ? {} : { successCriteria: [...node.success_criteria] }),
    });

    if (result.pending === true) {
      return awaitApprovalDecision(
        input,
        node.key,
        nodeExecId,
        result.expiresInMs ?? 0,
        approvalDecisions,
      );
    }
    return JSON.parse(result.outputJson) as Record<string, unknown>;
  } catch (error: unknown) {
    // Design log §4: a safety violation halts the whole workflow at once. It
    // is not handed to Recovery, and nothing waits for a recovery decision.
    if (isSafetyViolation(error)) {
      throw ApplicationFailure.nonRetryable(
        `Node "${node.key}" tripped a safety violation; the workflow halts`,
        SAFETY_VIOLATION_HALT_ERROR_TYPE,
        errorSummaryJson(error),
      );
    }
    const decided = await condition(
      () => nodeRetryDecisions.has(nodeExecId),
      input.nodeRecoveryTimeoutMs ?? NODE_RECOVERY_TIMEOUT_MS,
    );
    const decision = decided ? nodeRetryDecisions.get(nodeExecId) : undefined;

    if (decision === undefined) {
      throw ApplicationFailure.nonRetryable(
        `Node "${node.key}" failed and timed out awaiting a recovery decision`,
        NODE_RECOVERY_TIMED_OUT_ERROR_TYPE,
        errorSummaryJson(error),
      );
    }
    if (decision.action === "give_up") {
      throw ApplicationFailure.nonRetryable(
        `Node "${node.key}" failed and recovery gave up`,
        NODE_RECOVERY_GIVEN_UP_ERROR_TYPE,
        errorSummaryJson(error),
      );
    }
    // "retry" -- re-attempt with a fresh node_execution_id. The ledger
    // (NodeExecutionLedgerService.recordStarted) increments `attempt` for
    // the same dag_node_id automatically; this recursion is what produces
    // that second (or third, ...) real attempt.
    return executeNodeWithRecovery(
      input,
      node,
      predecessorKeys,
      approvalDecisions,
      nodeRetryDecisions,
    );
  }
}

export async function executorWorkflow(
  input: ExecutorWorkflowInput,
): Promise<ExecutorWorkflowResult> {
  // Registered as the very first statement (synchronous, before any
  // await) so a decision signal can never arrive before this workflow is
  // able to receive it.
  const approvalDecisions = new Map<string, ApprovalDecisionSignal>();
  setHandler(approvalDecidedSignal, (decision) => {
    approvalDecisions.set(decision.nodeExecutionId, decision);
  });
  const nodeRetryDecisions = new Map<string, NodeRetryDecision>();
  setHandler(nodeRetryDecidedSignal, (decision) => {
    nodeRetryDecisions.set(decision.nodeExecutionId, decision);
  });

  try {
    let raw: unknown;
    try {
      raw = JSON.parse(input.compiledDagJson);
    } catch (error: unknown) {
      throw validationFailure(
        `compiledDagJson is not valid JSON: ${(error as Error).message}`,
      );
    }
    const parsed = CompiledDagSchema.safeParse(raw);
    if (!parsed.success) {
      throw validationFailure(
        `compiledDagJson does not match CompiledDag: ${parsed.error.message}`,
      );
    }
    const dag = parsed.data;
    const nodesByKey = new Map(dag.nodes.map((node) => [node.key, node]));

    const outputs: Record<string, Record<string, unknown>> = {};

    // Parallel-wave execution (EXEC-7): waves run in order (wave N depends
    // on wave N-1), but every node within a wave is independent of its
    // wave-mates by construction (Graph Compiler's Kahn's-algorithm wave
    // assignment guarantees this) -- so they execute concurrently via
    // Promise.all. Cross-node data flows through the Blackboard (each
    // activity reads its own predecessors and writes its own output there,
    // see executor-activities.ts), not through this workflow's local
    // memory, so concurrent execution within a wave never races on shared
    // in-process state.
    for (const wave of orderedWaves(dag)) {
      const waveResults = await Promise.all(
        wave.node_keys.map(async (nodeKey) => {
          const node = nodesByKey.get(nodeKey);
          if (node === undefined) {
            throw validationFailure(`Wave references unknown node key "${nodeKey}"`);
          }

          if (isNodeGatedOff(dag, nodeKey, outputs)) {
            const gateNodeKeys = dag.edges
              .filter((edge) => edge.to === nodeKey && edge.kind === "conditional")
              .map((edge) => edge.from);
            return [nodeKey, gatedOffOutput(gateNodeKeys)] as const;
          }

          const output = await executeNodeWithRecovery(
            input,
            node,
            directPredecessorKeys(dag, nodeKey),
            approvalDecisions,
            nodeRetryDecisions,
          );
          return [nodeKey, output] as const;
        }),
      );

      for (const [nodeKey, output] of waveResults) {
        outputs[nodeKey] = output;
      }
    }

    await finalizeRun({
      tenantId: input.tenantId,
      runId: input.runId,
      status: "completed",
      errorJson: "",
    });
    return { outputs };
  } catch (error: unknown) {
    // finalizeRun is the only durable write of the run's terminal status
    // (EXEC-14) -- it must run for every failure path, including the
    // early validation throws above, so the `runs` row never gets stuck
    // in "running" forever.
    await finalizeRun({
      tenantId: input.tenantId,
      runId: input.runId,
      status: "failed",
      errorJson: errorSummaryJson(error),
    });
    throw error;
  }
}

/**
 * Durably waits (survives a worker restart -- Temporal replays this
 * condition() from history) for an approvalDecided signal matching this
 * node's execution ID, up to its expiry. Resolves the node's ledger row
 * via recordApprovalDecision either way, then either returns the node's
 * output (approved) or throws (rejected/expired), matching every other
 * node-failure path's semantics -- no partial-run continuation exists
 * yet (Recovery Policy Engine, not built).
 */
async function awaitApprovalDecision(
  input: ExecutorWorkflowInput,
  nodeKey: string,
  nodeExecutionId: string,
  expiresInMs: number,
  approvalDecisions: Map<string, ApprovalDecisionSignal>,
): Promise<Record<string, unknown>> {
  const decided = await condition(
    () => approvalDecisions.has(nodeExecutionId),
    Math.max(expiresInMs, 0),
  );
  const decision = decided ? approvalDecisions.get(nodeExecutionId) : undefined;

  if (decision === undefined) {
    await recordApprovalDecision({
      tenantId: input.tenantId,
      runId: input.runId,
      nodeExecutionId,
      nodeKey,
      decision: "rejected",
      outputJson: JSON.stringify({ approved: false, note: null, expired: true }),
    });
    throw ApplicationFailure.nonRetryable(
      `HumanApproval node "${nodeKey}" expired awaiting a decision`,
      HUMAN_APPROVAL_EXPIRED_ERROR_TYPE,
    );
  }

  await recordApprovalDecision({
    tenantId: input.tenantId,
    runId: input.runId,
    nodeExecutionId,
    nodeKey,
    decision: decision.approved ? "approved" : "rejected",
    outputJson: JSON.stringify({
      approved: decision.approved,
      note: decision.note ?? null,
      expired: false,
    }),
  });

  if (!decision.approved) {
    throw ApplicationFailure.nonRetryable(
      `HumanApproval node "${nodeKey}" was rejected`,
      HUMAN_APPROVAL_REJECTED_ERROR_TYPE,
    );
  }

  return { approved: true, note: decision.note ?? null };
}
