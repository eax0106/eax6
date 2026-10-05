import {v7 as uuidv7} from "uuid";
import type {AuditEventHandler} from "@alterx/shared-clients";
import {
  DeploymentAdminInternalActionRequestSchema,
  PlatformTenantIdSchema,
  TenantDeploymentCollectionSchema,
  type TenantDeploymentCollection,
  type DeploymentAdminActionRequest,
  type DeploymentAdminActionResult,
} from "@alterx/contracts";
import type { OrchestrationTenantStore } from "../workflow-lifecycle/workflow-lifecycle.service";

type DeploymentStatus = "pending" | "active" | "failed" | "rolled_back" | "suspended";

interface DeploymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly status: DeploymentStatus;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly revision: string;
}

interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export class DeploymentAdminNotFoundError extends Error {}
export class DeploymentAdminConflictError extends Error {}
export class DeploymentAdminPreconditionError extends Error {
  constructor(readonly status: 428 | 412) { super(status === 428 ? "If-Match is required" : "Deployment changed; reload before retrying"); }
}

export class DeploymentAdminService {
  constructor(private readonly store: OrchestrationTenantStore, private readonly audit: Pick<AuditEventHandler,"recordEvent">) {}

  list(tenantId: string): Promise<TenantDeploymentCollection> {
    const tenant = PlatformTenantIdSchema.parse(tenantId);
    return this.store.withTenant(tenant, async tx => {
      const selected = await tx.query<DeploymentRow & { project_name: string; total: string }>(
        `SELECT d.id,d.project_id,p.name AS project_name,d.status,d.created_at,d.updated_at,d.revision::text,count(*) OVER()::text AS total
         FROM deployments d JOIN projects p ON p.tenant_id=d.tenant_id AND p.id=d.project_id
         WHERE d.tenant_id=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT 200`, [tenant]);
      return TenantDeploymentCollectionSchema.parse({ tenant_id: tenant, total: Number(selected.rows[0]?.total ?? "0"),
        items: selected.rows.map(row => ({id: row.id, tenant_id: tenant, project_id: row.project_id, project_name: row.project_name,
          status: row.status, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
          etag: `"${row.id}:rev-${row.revision}"`,
        })),
      });
    });
  }

  async apply(input: DeploymentAdminActionRequest, staffUserId: string, ifMatch: string | undefined): Promise<DeploymentAdminActionResult> {
    const request = DeploymentAdminInternalActionRequestSchema.parse({...input,staff_user_id:staffUserId});
    if (!ifMatch?.trim()) throw new DeploymentAdminPreconditionError(428);
    return this.store.withTenant(request.tenant_id, async (tx) => {
      // Serialize all admin transitions for a project, including targets on different rows.
      const parent = await tx.query<{project_id:string}>("SELECT project_id FROM deployments WHERE tenant_id=$1 AND id=$2",[request.tenant_id,request.deployment_id]);
      if (!parent.rows[0]) throw new DeploymentAdminNotFoundError("Deployment was not found");
      const project = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.tenant_id,parent.rows[0].project_id]);
      if (!project.rows[0]) throw new DeploymentAdminNotFoundError("Deployment project was not found");
      const selected = await tx.query<DeploymentRow>(
        `SELECT id, project_id, status, created_at, updated_at, revision::text
         FROM deployments
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [request.tenant_id, request.deployment_id],
      );
      const target = selected.rows[0];
      if (!target) {
        throw new DeploymentAdminNotFoundError(`Deployment ${request.deployment_id} was not found`);
      }

      if (ifMatch !== etag(target)) throw new DeploymentAdminPreconditionError(412);
      const acknowledge = async (updated:DeploymentRow, activeId:string|null) => {
        const id=`daa_${uuidv7()}`;
        await tx.query(`INSERT INTO deployment_admin_actions(id,tenant_id,deployment_id,actor_ref,action,reason,previous_status,next_status,active_deployment_id,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,request.tenant_id,target.id,request.staff_user_id,request.action,request.reason,target.status,updated.status,activeId,updated.revision]);
        const ack=await this.audit.recordEvent({tenant_id:request.tenant_id,actor_type:"admin",actor_ref:request.staff_user_id,
          action:`deployment.${request.action}`,target_type:"deployment",target_ref:target.id,result:"success",reason_code:"staff_deployment_action",
          context_json:JSON.stringify({scope:`deployments:write:history:${id}`}),occurred_at:new Date().toISOString()});
        if (!/^[a-f0-9]{64}$/i.test(ack.entry_hash)) throw new Error("Deployment audit acknowledgement unavailable");
      };

      if (request.action === "suspend") {
        this.requireStatus(target, "active", request.action);
        const updated = await this.updateStatus(tx, request.tenant_id, target.id, "active", "suspended");
        await acknowledge(updated,null);
        return result(request, updated, null, "suspended");
      }

      if (request.action === "resume") {
        this.requireStatus(target, "suspended", request.action);
        const active = await tx.query<{ readonly id: string }>(
          `SELECT id FROM deployments
           WHERE tenant_id = $1 AND project_id = $2 AND status = 'active' AND id <> $3
           FOR UPDATE`,
          [request.tenant_id, target.project_id, target.id],
        );
        if (active.rows[0]) {
          throw new DeploymentAdminConflictError(
            `Project ${target.project_id} already has active deployment ${active.rows[0].id}`,
          );
        }
        const updated = await this.updateStatus(tx, request.tenant_id, target.id, "suspended", "active");
        await acknowledge(updated,updated.id);
        return result(request, updated, updated.id, "active");
      }

      this.requireStatus(target, "active", request.action);
      const previous = await tx.query<DeploymentRow>(
        `SELECT id, project_id, status, created_at, updated_at, revision::text
         FROM deployments
         WHERE tenant_id = $1 AND project_id = $2 AND status = 'rolled_back'
           AND created_at < $3
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [request.tenant_id, target.project_id, target.created_at],
      );
      const replacement = previous.rows[0];
      if (!replacement) {
        throw new DeploymentAdminConflictError(
          `Deployment ${target.id} has no previous deployment to restore`,
        );
      }
      const rolledBack = await this.updateStatus(tx, request.tenant_id, target.id, "active", "rolled_back");
      const restored = await this.updateStatus(
        tx,
        request.tenant_id,
        replacement.id,
        "rolled_back",
        "active",
      );
      await acknowledge(rolledBack,restored.id);
      return result(request, rolledBack, restored.id, "rolled_back");
    });
  }

  private requireStatus(
    deployment: DeploymentRow,
    expected: DeploymentStatus,
    action: DeploymentAdminActionRequest["action"],
  ): void {
    if (deployment.status !== expected) {
      throw new DeploymentAdminConflictError(
        `Cannot ${action} deployment ${deployment.id} from status ${deployment.status}`,
      );
    }
  }

  private async updateStatus(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    deploymentId: string,
    from: DeploymentStatus,
    to: DeploymentStatus,
  ): Promise<DeploymentRow> {
    const updated = await tx.query<DeploymentRow>(
      `UPDATE deployments
       SET status = $4, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2 AND status = $3
       RETURNING id, project_id, status, created_at, updated_at, revision::text`,
      [tenantId, deploymentId, from, to],
    );
    const row = updated.rows[0];
    if (!row) {
      throw new DeploymentAdminConflictError(
        `Deployment ${deploymentId} changed during ${from} to ${to} transition`,
      );
    }
    return row;
  }
}

function result(
  request: DeploymentAdminActionRequest,
  deployment: DeploymentRow,
  activeDeploymentId: string | null,
  status: "active" | "rolled_back" | "suspended",
  updatedAt: Date | string = deployment.updated_at,
): DeploymentAdminActionResult {
  return {
    tenant_id: request.tenant_id,
    deployment_id: request.deployment_id,
    project_id: deployment.project_id,
    action: request.action,
    status,
    active_deployment_id: activeDeploymentId,
    updated_at: new Date(updatedAt).toISOString(),
    etag: etag(deployment),
  };
}

function etag(row:DeploymentRow):string {return `"${row.id}:rev-${row.revision}"`;}
