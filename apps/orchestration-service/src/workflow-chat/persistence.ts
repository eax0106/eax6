import type { OrchestrationTransactionLike } from "../project-read/project-read.service";

/** Stable chat identity also exposes old workflows without making a read write. */
export async function ensureWorkflowChat(
  tx: OrchestrationTransactionLike, tenant: string, workspace: string, workflowId: string, user: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO conversations (id,tenant_id,workspace_id,channel,temporal_workflow_id,workflow_id,owner_user_id,chat_type)
     SELECT 'cnv_' || substring(id FROM 4),tenant_id,workspace_id,'web','convwf_' || substring(id FROM 4),id,$4,'workflow_builder'
     FROM workflows WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
     ON CONFLICT (tenant_id,workflow_id) WHERE chat_type='workflow_builder' DO NOTHING`,
    [tenant,workspace,workflowId,user],
  );
}
