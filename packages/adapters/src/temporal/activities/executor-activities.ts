import { ApplicationFailure } from "@temporalio/client";
import type { BlackboardHandlerClient } from "../../grpc/blackboard-client";
import { RECOVERY_CLARIFICATION_PREFIX, SAFETY_VIOLATION_PREFIX } from "../../grpc/nodeexec-grpc-transport";
import type { NodeExecutionHandler } from "../../grpc/nodeexec-client";

export interface ExecuteNodeActivityInput {
  readonly tenantId: string; // ten_ prefixed UUIDv7
  readonly runId: string; // run_ prefixed UUIDv7
  readonly nodeExecutionId: string; // node_ prefixed UUIDv7
  readonly nodeKey: string;
  readonly nodeType: string;
  readonly configJson: string;
  /** Direct upstream node keys -- their outputs are read from the Blackboard, not passed inline. */
  readonly predecessorKeys: readonly string[];
  /** C29: the compiled node's own success criteria; absent on older workflows. */
  readonly successCriteria?: readonly string[];
}

export interface ExecuteNodeActivityResult {
  readonly outputJson: string;
  readonly metadataJson: string;
  /** True when the node is a HumanApproval request still awaiting a decision (HEAL-7). */
  readonly pending?: boolean;
  /** Milliseconds from now until the approval expires; only set when pending. */
  readonly expiresInMs?: number;
  /** D5: on expiry the run continues past this approval (flagged) instead of failing. */
  readonly skipOnTimeout?: boolean;
}

export interface FinalizeRunActivityInput {
  readonly tenantId: string; // ten_ prefixed UUIDv7
  readonly runId: string; // run_ prefixed UUIDv7
  readonly status: "completed" | "failed";
  readonly errorJson: string; // empty string when status = "completed"
}

export interface RecordApprovalDecisionActivityInput {
  readonly tenantId: string; // ten_ prefixed UUIDv7
  readonly runId: string; // run_ prefixed UUIDv7
  readonly nodeExecutionId: string; // node_ prefixed UUIDv7
  readonly nodeKey: string;
  readonly decision: "approved" | "rejected";
  readonly outputJson: string; // {"approved": bool, "note": string|null, "expired": bool}
}

export interface ExecutorActivities {
  executeNode(input: ExecuteNodeActivityInput): Promise<ExecuteNodeActivityResult>;
  /** Called once from the workflow's try/finally -- see executor-workflow.ts. */
  finalizeRun(input: FinalizeRunActivityInput): Promise<void>;
  /**
   * Called once a durably-awaited HumanApproval decision (or expiry)
   * arrives -- resolves the node_execution's ledger row and publishes the
   * real decision to the Blackboard, overwriting the pending placeholder.
   * HEAL-7.
   */
  recordApprovalDecision(input: RecordApprovalDecisionActivityInput): Promise<void>;
}

/**
 * All real I/O for the Executor happens here, never in the workflow file.
 *
 * Cross-node data flows through the Blackboard (EXEC-5/EXEC-7), not
 * through Temporal workflow memory: this activity reads each direct
 * predecessor's output from the Blackboard (parallel reads -- they're
 * independent of each other), dispatches to the Node Execution Service
 * (EXEC-6, which owns every handler dispatch decision -- no business
 * logic here), then writes its own output back to the Blackboard so
 * later nodes (possibly in a later wave, possibly a sibling in the same
 * wave that also depends on this node) can read it the same way.
 *
 * A missing predecessor value (not yet written, or genuinely absent) is
 * passed through as an empty object rather than failing the node --
 * matches NodeexecService's existing inputs_json contract, where an
 * unlisted upstream key simply means "no data from that node".
 */
/** The failure type a safety halt carries from the activity to the workflow. */
export const SAFETY_VIOLATION_FAILURE_TYPE = "SafetyViolation";

function markedFailureDetail(error: unknown, prefix: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { readonly details?: unknown; readonly message?: unknown };
  for (const text of [record.details, record.message]) {
    if (typeof text !== "string") continue;
    const at = text.indexOf(prefix);
    if (at !== -1) return text.slice(at);
  }
  return undefined;
}

function readSkipOnTimeout(outputJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(outputJson);
    return typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>)["skip_on_timeout"] === true;
  } catch {
    return false;
  }
}

export function createExecutorActivities(
  nodeExecutionClient: NodeExecutionHandler,
  blackboardClient: BlackboardHandlerClient,
): ExecutorActivities {
  return {
    async executeNode(input: ExecuteNodeActivityInput): Promise<ExecuteNodeActivityResult> {
      const inputs: Record<string, Record<string, unknown>> = {};
      await Promise.all(
        input.predecessorKeys.map(async (predecessorKey) => {
          const read = await blackboardClient.readValue({
            tenant_id: input.tenantId,
            run_id: input.runId,
            key: predecessorKey,
          });
          if (read.found) {
            inputs[predecessorKey] = JSON.parse(read.value_json) as Record<
              string,
              unknown
            >;
          }
        }),
      );

      let response: Awaited<ReturnType<NodeExecutionHandler["executeNode"]>>;
      try {
        response = await nodeExecutionClient.executeNode({
          tenant_id: input.tenantId,
          run_id: input.runId,
          node_execution_id: input.nodeExecutionId,
          node_key: input.nodeKey,
          node_type: input.nodeType,
          config_json: input.configJson,
          inputs_json: JSON.stringify(inputs),
          success_criteria: [...(input.successCriteria ?? [])],
        });
      } catch (error: unknown) {
        // Design log §4: a safety violation is never retried -- not by this
        // activity's retry policy, not by Recovery. It reaches the workflow
        // as its own non-retryable type, and the workflow halts.
        const detail = markedFailureDetail(error, SAFETY_VIOLATION_PREFIX);
        if (detail !== undefined) {
          throw ApplicationFailure.nonRetryable(detail, SAFETY_VIOLATION_FAILURE_TYPE);
        }
        const clarification = markedFailureDetail(error, RECOVERY_CLARIFICATION_PREFIX);
        if (clarification !== undefined) {
          throw ApplicationFailure.nonRetryable(clarification, "RecoveryClarification");
        }
        throw error;
      }

      await blackboardClient.writeValue({
        tenant_id: input.tenantId,
        run_id: input.runId,
        key: input.nodeKey,
        value_json: response.output_json,
      });

      const pending = isPendingApproval(response.metadata_json);
      if (!pending) {
        return {
          outputJson: response.output_json,
          metadataJson: response.metadata_json,
        };
      }

      const expiryAt = readExpiryAt(response.output_json);
      const expiresInMs =
        expiryAt === undefined ? 0 : Math.max(new Date(expiryAt).getTime() - Date.now(), 0);
      return {
        outputJson: response.output_json,
        metadataJson: response.metadata_json,
        pending: true,
        expiresInMs,
        ...(readSkipOnTimeout(response.output_json) ? { skipOnTimeout: true } : {}),
      };
    },

    async recordApprovalDecision(
      input: RecordApprovalDecisionActivityInput,
    ): Promise<void> {
      await nodeExecutionClient.finalizeApprovalNode({
        tenant_id: input.tenantId,
        run_id: input.runId,
        node_execution_id: input.nodeExecutionId,
        node_key: input.nodeKey,
        decision: input.decision,
        decision_output_json: input.outputJson,
      });
      await blackboardClient.writeValue({
        tenant_id: input.tenantId,
        run_id: input.runId,
        key: input.nodeKey,
        value_json: input.outputJson,
      });
    },

    async finalizeRun(input: FinalizeRunActivityInput): Promise<void> {
      await nodeExecutionClient.finalizeRun({
        tenant_id: input.tenantId,
        run_id: input.runId,
        status: input.status,
        error_json: input.errorJson,
      });
    },
  };
}

function isPendingApproval(metadataJson: string): boolean {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>)["execution_status"] === "pending_approval"
    );
  } catch {
    return false;
  }
}

function readExpiryAt(outputJson: string): string | undefined {
  try {
    const parsed = JSON.parse(outputJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const expiryAt = (parsed as Record<string, unknown>)["expiry_at"];
    return typeof expiryAt === "string" ? expiryAt : undefined;
  } catch {
    return undefined;
  }
}
