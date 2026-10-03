import { TenantIdSchema, WorkspaceIdSchema, WorkflowIdSchema, WorkflowHealthResourceSchema, type WorkflowHealthDimension } from "@alterx/contracts";
import type { OrchestrationTenantStore } from "../project-read/project-read.service";
import { WorkflowNotFoundError, WorkflowValidationError } from "../workflow-read/workflow-read.service";

type Counts = { passed: number; observations: number };
const status = (score: number | null) => score === null ? "not_enough_data" : score < 50 ? "critical" : score < 80 ? "warning" : "healthy";
function dimension(counts: Counts, summary: string): WorkflowHealthDimension {
  const score = counts.observations === 0 ? null : 100 * counts.passed / counts.observations;
  return { passed: counts.passed, observations: counts.observations, score, status: status(score), summary };
}

export class WorkflowHealthService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async get(tenantId: string, workspaceId: string, workflowId: string) {
    if (!TenantIdSchema.safeParse(tenantId).success || !WorkspaceIdSchema.safeParse(workspaceId).success || !WorkflowIdSchema.safeParse(workflowId).success) throw new WorkflowValidationError("Health requires valid tenant, workspace and workflow identities");
    const tenant = TenantIdSchema.parse(tenantId).slice(4), workspace = WorkspaceIdSchema.parse(workspaceId).slice(3), workflow = WorkflowIdSchema.parse(workflowId);
    const endAt = new Date().toISOString(), startAt = new Date(Date.parse(endAt) - 7 * 86400000).toISOString();
    return this.store.withTenant(tenant, async tx => {
      const owned = await tx.query("SELECT id FROM workflows WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [tenant, workspace, workflow]);
      if (!owned.rows[0]) throw new WorkflowNotFoundError(workflow);
      const runs = await tx.query<{id:string}>(`SELECT id FROM runs WHERE tenant_id=$1 AND workspace_id=$2 AND workflow_id=$3
        AND created_at >= $4::timestamptz AND created_at <= $5::timestamptz ORDER BY created_at DESC,id DESC LIMIT 20`, [tenant, workspace, workflow, startAt, endAt]);
      const ids = runs.rows.map(row => row.id), parameters = [tenant, ids];
      const validationFailed = `(coalesce(error->>'error_code','') LIKE '%\\_VALIDATION\\_FAILED' ESCAPE '\\' OR coalesce(error->>'error_code','')='MODEL_OUTPUT_INVALID')`;
      const validation = await tx.query<Counts>(`SELECT count(*) FILTER(WHERE status IN ('succeeded','recovered') AND NOT ${validationFailed})::int AS passed,
        count(*) FILTER(WHERE status IN ('succeeded','recovered') OR ${validationFailed})::int AS observations FROM node_executions WHERE tenant_id=$1 AND run_id=ANY($2::text[])`, parameters);
      const unavailable = `EXISTS(SELECT 1 FROM recovery_actions a WHERE a.tenant_id=n.tenant_id AND a.run_id=n.run_id AND a.node_execution_id=n.id
        AND a.failure_class IN ('infrastructure_failure','timeout','tool_permission_denial','sandbox_crash','rate_limit','credential_missing'))`;
      const availability = await tx.query<Counts>(`SELECT count(*) FILTER(WHERE n.status IN ('succeeded','recovered') AND NOT ${unavailable})::int AS passed,
        count(*) FILTER(WHERE n.status IN ('succeeded','recovered') OR ${unavailable})::int AS observations FROM node_executions n WHERE n.tenant_id=$1 AND n.run_id=ANY($2::text[])`, parameters);
      const correctness = await tx.query<Counts>(`SELECT count(*) FILTER(WHERE verdict='pass')::int AS passed,
        count(*) FILTER(WHERE verdict IN ('pass','fail'))::int AS observations FROM verification_results WHERE tenant_id=$1 AND run_id=ANY($2::text[])`, parameters);
      const reliability = await tx.query<Counts & {failures:number;degraded:number}>(`SELECT count(*) FILTER(WHERE verdict='completed_verified' AND recovery_count=0 AND NOT human_rescue)::int AS passed,
        count(*)::int AS observations,count(*) FILTER(WHERE verdict='failed')::int AS failures,
        count(*) FILTER(WHERE verdict IN ('degraded','rescued') OR recovery_count>0 OR human_rescue)::int AS degraded
        FROM run_outcomes WHERE tenant_id=$1 AND run_id=ANY($2::text[])`, parameters);
      const dimensions = {
        validation: dimension(validation.rows[0]!, "Recorded steps accepted input/output shape; explicit validation errors fail."),
        availability: dimension(availability.rows[0]!, "Recorded step dispatches without a classified availability failure."),
        correctness: dimension(correctness.rows[0]!, "Recorded verification checks passed; unconfirmed checks remain unknown."),
        reliability: dimension(reliability.rows[0]!, "Recorded runs completed verified without recovery or human rescue."),
      };
      const scores = Object.values(dimensions).map(value => value.score);
      const overallScore = scores.every(score => score !== null) ? scores.reduce<number>((sum, score) => sum + score!, 0) / 4 : null;
      return WorkflowHealthResourceSchema.parse({ workflowId: workflow, overallScore,
        status: overallScore === null ? "not_enough_data" : status(Math.min(...scores as number[])), dimensions,
        recentFailures: reliability.rows[0]!.failures, degradedRuns: reliability.rows[0]!.degraded, lastEvaluatedAt: endAt,
        window: { startAt, endAt, maximumRuns: 20, sampledRuns: ids.length },
      });
    });
  }
}
