import { NodeExecutionIdSchema, RunIdSchema, TenantIdSchema } from "@alterx/contracts";

import {
  RunNotFoundError,
  RunValidationError,
  type OrchestrationTenantStore,
} from "./run-launcher.service";

export interface NodeExecutionRecoveryInfo {
  readonly isRetry: boolean;
  readonly isRecovery: boolean;
}

export interface RunWorkspaceLookup {
  readonly workspaceId: string;
  readonly workflowId: string;
}

export class NodeExecutionNotFoundError extends Error {
  constructor(nodeExecutionId: string) {
    super(`Node execution ${nodeExecutionId} was not found`);
    this.name = "NodeExecutionNotFoundError";
  }
}

/**
 * Minimal, dedicated lookup for the Cost Ledger's ingestion (OUT-4's
 * getWorkspaceId; getRecoveryInfo added for OUT-5): resolves data it needs
 * without joining across cost_db's boundary (doc 04 SS1). Deliberately its
 * own queries rather than reusing RunLauncherService's RUN_SELECT_COLUMNS --
 * that select list is shared by createRun/listRuns/getRun and doesn't carry
 * this data; adding it there would widen an unrelated response shape for
 * every caller.
 */
export class RunWorkspaceLookupService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async getRunWorkspaceResponse(tenantId: string, runId: string) {
    const row = await this.getRunWorkspace(tenantId, runId);
    return { workspace_id: row.workspaceId.startsWith("ws_") ? row.workspaceId : `ws_${row.workspaceId}`, workflow_id: row.workflowId };
  }

  async getWorkspaceId(tenantIdInput: string, runIdInput: string): Promise<string> {
    return (await this.getRunWorkspace(tenantIdInput, runIdInput)).workspaceId;
  }

  async getRunWorkspace(
    tenantIdInput: string,
    runIdInput: string,
  ): Promise<RunWorkspaceLookup> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const runId = validatedRunId(runIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        readonly workspace_id: string;
        readonly workflow_id: string;
      }>(
        "SELECT workspace_id, workflow_id FROM runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, runId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const call = await tx.query<{ workspace_id: string; workflow_id: string | null }>(
          `SELECT m.workspace_id,c.workflow_id FROM conversation_messages m JOIN conversations c
           ON c.tenant_id=m.tenant_id AND c.workspace_id=m.workspace_id AND c.id=m.conversation_id
           WHERE m.tenant_id=$1 AND m.model_run_id=$2 AND c.chat_type='general'`, [tenantId,runId]);
        if (!call.rows[0]) throw new RunNotFoundError(runId);
        return { workspaceId: call.rows[0].workspace_id, workflowId: call.rows[0].workflow_id ?? "" };
      }
      if (row.workflow_id === null || row.workflow_id === "") {
        throw new RunNotFoundError(runId);
      }
      return { workspaceId: row.workspace_id, workflowId: row.workflow_id };
    });
  }

  /**
   * OUT-5: real is_retry/is_recovery signal for a cost event's node
   * execution -- is_retry from the node's real `attempt` counter
   * (node_executions.attempt > 1, EXEC-14), is_recovery from whether a
   * recovery_actions row exists for it (HEAL-5/6). Both real DB facts,
   * queried once each within the same tenant-scoped transaction.
   */
  async getRecoveryInfo(
    tenantIdInput: string,
    runIdInput: string,
    nodeExecutionIdInput: string,
  ): Promise<NodeExecutionRecoveryInfo> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const runId = validatedRunId(runIdInput);
    const nodeExecutionId = validatedNodeExecutionId(nodeExecutionIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const nodeResult = await tx.query<{ readonly attempt: number }>(
        "SELECT attempt FROM node_executions WHERE tenant_id = $1 AND run_id = $2 AND id = $3",
        [tenantId, runId, nodeExecutionId],
      );
      const nodeRow = nodeResult.rows[0];
      if (nodeRow === undefined) {
        const call = await tx.query(`SELECT m.id FROM conversation_messages m JOIN conversations c
          ON c.tenant_id=m.tenant_id AND c.workspace_id=m.workspace_id AND c.id=m.conversation_id
          WHERE m.tenant_id=$1 AND m.model_run_id=$2 AND m.model_node_execution_id=$3 AND c.chat_type='general'`,[tenantId,runId,nodeExecutionId]);
        if (!call.rows[0]) throw new NodeExecutionNotFoundError(nodeExecutionId);
        return { isRetry: false, isRecovery: false };
      }

      const recoveryResult = await tx.query<{ readonly exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM recovery_actions
           WHERE tenant_id = $1 AND run_id = $2 AND node_execution_id = $3
         ) AS exists`,
        [tenantId, runId, nodeExecutionId],
      );

      return {
        isRetry: nodeRow.attempt > 1,
        isRecovery: recoveryResult.rows[0]?.exists === true,
      };
    });
  }
}

function validatedNodeExecutionId(nodeExecutionId: string): string {
  const parsed = NodeExecutionIdSchema.safeParse(nodeExecutionId);
  if (!parsed.success) {
    throw new RunValidationError(`Invalid node_execution_id: ${nodeExecutionId}`);
  }
  return parsed.data;
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new RunValidationError(`Invalid tenant_id: ${tenantId}`);
  }
  return parsed.data.slice("ten_".length);
}

function validatedRunId(runId: string): string {
  const parsed = RunIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new RunValidationError(`Invalid run_id: ${runId}`);
  }
  return parsed.data;
}
