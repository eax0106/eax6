import { createHash } from "node:crypto";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { CompiledDagSchema, hasExternalSideEffect } from "@alterx/contracts";

import type { OrchestrationTenantStore } from "./approvals.service";

interface TransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

/** Approvals in a row after which a promotion to "Always go ahead" is suggested (D5). */
export const PROMOTION_SUGGESTION_THRESHOLD = 10;

export type ApprovalMode = "ask" | "auto";

export class ApprovalPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalPolicyValidationError";
  }
}

export class ApprovalPolicyStaleError extends Error {
  constructor() {
    super("Approval policy changed since it was read");
    this.name = "ApprovalPolicyStaleError";
  }
}

export class ApprovalPolicyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalPolicyNotFoundError";
  }
}

/** "Always go ahead" on a side-effect step needs the named consequence confirmed. */
export class ApprovalPolicyConfirmationRequiredError extends Error {
  constructor(readonly consequence: string) {
    super(`Confirm the consequence to continue: ${consequence}`);
    this.name = "ApprovalPolicyConfirmationRequiredError";
  }
}

export interface ApprovalStepPolicy {
  readonly etag: string;
  readonly nodeKey: string;
  readonly mode: ApprovalMode;
  /** Set when the step guards a side effect; auto then needs it confirmed. */
  readonly sideEffectConsequence: string | null;
  readonly autoConfirmedBy: string | null;
  readonly autoConfirmedAt: string | null;
  readonly skipOnTimeout: boolean;
  readonly timeoutSeconds: number | null;
  readonly consecutiveApprovals: number;
  readonly promotionSuggested: boolean;
  readonly setBy: string | null;
  readonly updatedAt: string | null;
}

export interface SetApprovalStepPolicyInput {
  readonly mode: ApprovalMode;
  readonly skipOnTimeout: boolean;
  readonly timeoutSeconds: number | null;
  /** The consequence text the person confirmed, required for auto on a side-effect step. */
  readonly confirmConsequence?: string;
  readonly setBy: string;
}

/** What the HumanApproval node applies at run time. */
export interface AppliedApprovalPolicy {
  readonly mode: ApprovalMode;
  readonly setBy: string | null;
  readonly skipOnTimeout: boolean;
  readonly timeoutSeconds: number | null;
}

interface PolicyRow extends Record<string, unknown> {
  readonly node_key: string;
  readonly mode: ApprovalMode;
  readonly side_effect_consequence: string | null;
  readonly auto_confirmed_by: string | null;
  readonly auto_confirmed_at: string | null;
  readonly skip_on_timeout: boolean;
  readonly timeout_seconds: number | null;
  readonly consecutive_approvals: number;
  readonly set_by: string;
  readonly updated_at: string;
}

const POLICY_COLUMNS = `node_key, mode, side_effect_consequence, auto_confirmed_by,
  auto_confirmed_at::text, skip_on_timeout, timeout_seconds, consecutive_approvals,
  set_by, updated_at::text`;

const CONSEQUENCES: Readonly<Record<string, string>> = {
  "email.send": "this will send emails without asking",
  "whatsapp.send": "this will send WhatsApp messages without asking",
  "database.insert": "this will write to databases without asking",
  "database.update": "this will write to databases without asking",
  "database.delete": "this will delete database records without asking",
  "browser.click": "this will click in browsers without asking",
};

/**
 * D5 approval modes, per approval step of a workflow. The steps are the
 * HumanApproval nodes of the workflow's promoted version (latest version
 * when none is promoted); a step with no stored row is "Ask me first".
 */
export class ApprovalPolicyService {
  constructor(private readonly store: OrchestrationTenantStore, private readonly audit: AuditEventHandler) {}

  async list(tenantId: string, workspaceId: string, workflowId: string): Promise<readonly ApprovalStepPolicy[]> {
    return this.store.withTenant(tenantId, async (tx) => {
      const steps = await approvalSteps(tx, tenantId, workspaceId, workflowId);
      const rows = await tx.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS} FROM approval_step_policies WHERE tenant_id = $1 AND workflow_id = $2`,
        [tenantId, workflowId],
      );
      const stored = new Map(rows.rows.map((row) => [row.node_key, row]));
      return [...steps].map(([nodeKey, consequence]) => view(nodeKey, consequence, stored.get(nodeKey)));
    });
  }

  async set(
    tenantId: string,
    workspaceId: string,
    workflowId: string,
    nodeKey: string,
    input: SetApprovalStepPolicyInput,
    ifMatch: string,
  ): Promise<ApprovalStepPolicy> {
    if (input.skipOnTimeout && input.timeoutSeconds === null) {
      throw new ApprovalPolicyValidationError("skip_on_timeout needs timeout_seconds");
    }
    if (input.timeoutSeconds !== null && (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 60 || input.timeoutSeconds > 2_592_000)) {
      throw new ApprovalPolicyValidationError("timeout_seconds must be a whole number from 60 to 2592000");
    }
    return this.store.withTenant(tenantId, async (tx) => {
      // Lock the workflow too: the first policy write has no policy row to lock.
      await tx.query("SELECT id FROM workflows WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE", [tenantId, workspaceId, workflowId]);
      const steps = await approvalSteps(tx, tenantId, workspaceId, workflowId);
      if (!steps.has(nodeKey)) throw new ApprovalPolicyNotFoundError(`Workflow ${workflowId} has no approval step ${nodeKey}`);
      const consequence = steps.get(nodeKey) ?? null;
      const confirmed = input.mode === "auto" && consequence !== null;
      if (confirmed && input.confirmConsequence !== consequence) {
        throw new ApprovalPolicyConfirmationRequiredError(consequence);
      }
      const current = await tx.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS} FROM approval_step_policies
          WHERE tenant_id = $1 AND workflow_id = $2 AND node_key = $3 FOR UPDATE`,
        [tenantId, workflowId, nodeKey],
      );
      if (ifMatch !== view(nodeKey, consequence, current.rows[0]).etag) throw new ApprovalPolicyStaleError();
      // Moving to auto ends the streak the promotion suggestion counted.
      const resetCounter = input.mode === "auto" && current.rows[0]?.mode !== "auto";
      const result = await tx.query<PolicyRow>(
        `INSERT INTO approval_step_policies
           (tenant_id, workspace_id, workflow_id, node_key, mode, side_effect_consequence,
            auto_confirmed_by, auto_confirmed_at, skip_on_timeout, timeout_seconds, set_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE clock_timestamp() END,
                 $8, $9, $10, clock_timestamp())
         ON CONFLICT (tenant_id, workflow_id, node_key) DO UPDATE SET
           mode = EXCLUDED.mode,
           side_effect_consequence = EXCLUDED.side_effect_consequence,
           auto_confirmed_by = EXCLUDED.auto_confirmed_by,
           auto_confirmed_at = EXCLUDED.auto_confirmed_at,
           skip_on_timeout = EXCLUDED.skip_on_timeout,
           timeout_seconds = EXCLUDED.timeout_seconds,
           consecutive_approvals = CASE WHEN $11 THEN 0 ELSE approval_step_policies.consecutive_approvals END,
           set_by = EXCLUDED.set_by,
           updated_at = EXCLUDED.updated_at
         RETURNING ${POLICY_COLUMNS}`,
        [
          tenantId, workspaceId, workflowId, nodeKey, input.mode, consequence,
          confirmed ? input.setBy : null, input.skipOnTimeout, input.timeoutSeconds, input.setBy, resetCounter,
        ],
      );
      await this.audit.recordEvent({
        tenant_id: tenantId,
        actor_type: "user",
        actor_ref: input.setBy,
        action: "approval.policy.update",
        target_type: "workflow",
        target_ref: `${workflowId}/${nodeKey}`,
        result: "success",
        reason_code: confirmed ? "consequence_confirmed" : "",
        context_json: JSON.stringify({ scope: "approval_policy" }),
        occurred_at: new Date().toISOString(),
      });
      return view(nodeKey, consequence, result.rows[0]);
    });
  }
}

/** The policy of the approval step a node execution belongs to, inside the request's transaction. */
export async function appliedPolicy(
  tx: TransactionLike,
  tenantId: string,
  runId: string,
  nodeExecutionId: string,
): Promise<AppliedApprovalPolicy> {
  const result = await tx.query<{ mode: ApprovalMode; set_by: string; skip_on_timeout: boolean; timeout_seconds: number | null }>(
    `SELECT p.mode, p.set_by, p.skip_on_timeout, p.timeout_seconds
       FROM runs r
       JOIN node_executions n ON n.tenant_id = r.tenant_id AND n.run_id = r.id AND n.id = $3
       JOIN approval_step_policies p
         ON p.tenant_id = r.tenant_id AND p.workflow_id = r.workflow_id AND p.node_key = n.dag_node_id
      WHERE r.tenant_id = $1 AND r.id = $2`,
    [tenantId, runId, nodeExecutionId],
  );
  const row = result.rows[0];
  if (row === undefined) return { mode: "ask", setBy: null, skipOnTimeout: false, timeoutSeconds: null };
  return { mode: row.mode, setBy: row.set_by, skipOnTimeout: row.skip_on_timeout, timeoutSeconds: row.timeout_seconds };
}

/**
 * Counts a person's decision on the step: an approval extends the streak
 * behind the promotion suggestion, a rejection ends it. Auto approvals are
 * never counted.
 */
export async function countDecision(
  tx: TransactionLike,
  tenantId: string,
  approvalId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  await tx.query(
    `INSERT INTO approval_step_policies
       (tenant_id, workspace_id, workflow_id, node_key, consecutive_approvals, set_by)
     SELECT a.tenant_id, a.workspace_id, r.workflow_id, n.dag_node_id,
            CASE WHEN $3 = 'approved' THEN 1 ELSE 0 END, 'system:default'
       FROM approvals a
       JOIN runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
       JOIN node_executions n ON n.tenant_id = a.tenant_id AND n.id = a.node_execution_id
      WHERE a.tenant_id = $1 AND a.id = $2 AND r.workflow_id IS NOT NULL
     ON CONFLICT (tenant_id, workflow_id, node_key) DO UPDATE SET
       consecutive_approvals = CASE WHEN $3 = 'approved'
         THEN approval_step_policies.consecutive_approvals + 1 ELSE 0 END`,
    [tenantId, approvalId, decision],
  );
}

/** HumanApproval node keys of the workflow mapped to their side-effect consequence (or null). */
async function approvalSteps(
  tx: TransactionLike,
  tenantId: string,
  workspaceId: string,
  workflowId: string,
): Promise<Map<string, string | null>> {
  const versions = await tx.query<{ compiled_dag: unknown }>(
    `SELECT v.compiled_dag FROM workflow_versions v
       JOIN workflows w ON w.tenant_id = v.tenant_id AND w.id = v.workflow_id
      WHERE v.tenant_id = $1 AND v.workflow_id = $2 AND w.workspace_id = $3
      ORDER BY (v.status = 'promoted') DESC, v.version DESC
      LIMIT 1`,
    [tenantId, workflowId, workspaceId],
  );
  const row = versions.rows[0];
  if (row === undefined) throw new ApprovalPolicyNotFoundError(`Workflow ${workflowId} was not found`);
  const dag = CompiledDagSchema.safeParse(row.compiled_dag);
  if (!dag.success) return new Map();
  const nodes = new Map(dag.data.nodes.map((node) => [node.key, node]));
  const steps = new Map<string, string | null>();
  for (const node of dag.data.nodes) {
    if (node.type !== "HumanApproval") continue;
    const action = node.config["requested_action"];
    const guarded = typeof action === "object" && action !== null && !Array.isArray(action)
      ? nodes.get(String((action as Record<string, unknown>)["node_key"]))
      : undefined;
    const tool = guarded?.type === "ToolCall" ? guarded.config["tool_name"] : undefined;
    steps.set(node.key, typeof tool === "string" && hasExternalSideEffect(tool) ? CONSEQUENCES[tool] ?? "this will act outside Alter without asking" : null);
  }
  return steps;
}

function view(nodeKey: string, consequence: string | null, row: PolicyRow | undefined): ApprovalStepPolicy {
  const mode = row?.mode ?? "ask";
  const consecutiveApprovals = row?.consecutive_approvals ?? 0;
  const etag = `"${createHash("sha256").update(JSON.stringify({ nodeKey, consequence, mode, updatedAt: row?.updated_at ?? null })).digest("hex")}"`;
  return {
    etag,
    nodeKey,
    mode,
    sideEffectConsequence: consequence,
    autoConfirmedBy: row?.auto_confirmed_by ?? null,
    autoConfirmedAt: row?.auto_confirmed_at ?? null,
    skipOnTimeout: row?.skip_on_timeout ?? false,
    timeoutSeconds: row?.timeout_seconds ?? null,
    consecutiveApprovals,
    promotionSuggested: mode === "ask" && consecutiveApprovals >= PROMOTION_SUGGESTION_THRESHOLD,
    setBy: row === undefined || row.set_by === "system:default" ? null : row.set_by,
    updatedAt: row?.updated_at ?? null,
  };
}
