import { TenantIdSchema } from "@alterx/contracts";

import type { OrchestrationTenantStore } from "../runs/run-observability.service";

export type AgentWorkflowRow = {
  readonly workflow_id: string;
  readonly workspace_id: string;
  readonly name: string;
};

export class AgentWorkflowsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkflowsValidationError";
  }
}

/** How far back a workflow counts as using an agent. */
const LOOKBACK_DAYS = 30;
const MAX_WORKFLOWS = 100;
const AGENT_ID = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The workflows whose steps an agent ran recently (section 17, D1): the
 * Drift Detector scores agents, not workflows, so a suggestion about an agent
 * reaches the people who own the workflows it has been working in.
 */
export class AgentWorkflowsService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async recentWorkflows(tenantIdInput: string, agentId: string): Promise<readonly AgentWorkflowRow[]> {
    const parsed = TenantIdSchema.safeParse(tenantIdInput.startsWith("ten_") ? tenantIdInput : `ten_${tenantIdInput}`);
    if (!parsed.success) throw new AgentWorkflowsValidationError("tenant must be a ten_ prefixed UUIDv7");
    if (!AGENT_ID.test(agentId)) throw new AgentWorkflowsValidationError("agent_id must be an agt_ id");
    const tenantId = parsed.data.slice("ten_".length);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<AgentWorkflowRow>(
        `SELECT DISTINCT w.id AS workflow_id, w.workspace_id::text AS workspace_id, w.name
           FROM node_executions ne
           JOIN runs r ON r.tenant_id = ne.tenant_id AND r.id = ne.run_id
           JOIN workflows w ON w.tenant_id = r.tenant_id AND w.id = r.workflow_id
          WHERE ne.tenant_id = $1 AND ne.agent_id = $2
            AND ne.started_at > clock_timestamp() - make_interval(days => $3)
          ORDER BY w.id
          LIMIT $4`,
        [tenantId, agentId, LOOKBACK_DAYS, MAX_WORKFLOWS],
      );
      return result.rows;
    });
  }
}
