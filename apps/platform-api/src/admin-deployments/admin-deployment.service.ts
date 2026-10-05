import type {Pool} from "pg";
import {AdminDeploymentHttpError} from "./problem";
import { Injectable } from "@nestjs/common";
import type {
  DeploymentAdminActionRequest,
  DeploymentAdminActionResult,
} from "@alterx/contracts";
import { AdminAuditService } from "../admin-audit";
import { DeploymentAdminClient } from "../engine";

@Injectable()
export class AdminDeploymentService {
  constructor(
    private readonly client: DeploymentAdminClient,
    private readonly audit: AdminAuditService,
    private readonly pool: Pool,
  ) {}

  async list(tenantId: string, staffUserId: string, traceparent: string | undefined) {
    return this.withSubject(tenantId,async()=>{
    const result = await this.client.list(tenantId, traceparent);
    await this.audit.record({tenantId,actorType:"admin",actorRef:staffUserId,action:"deployment.list",targetType:"tenant",targetRef:tenantId,reasonCode:"",scope:"deployments:read"});
    return result;
    });
  }

  async apply(
    input: DeploymentAdminActionRequest,
    staffUserId: string,
    traceparent: string | undefined,
    ifMatch: string | undefined,
  ): Promise<DeploymentAdminActionResult> {
    return this.withSubject(input.tenant_id,()=>this.client.apply(input, staffUserId, ifMatch, traceparent));
  }
  private async withSubject<T>(tenantId:string,operation:()=>Promise<T>):Promise<T>{
    const tx=await this.pool.connect();
    try{
      await tx.query("BEGIN");await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenantId]);
      const tenant=await tx.query("SELECT id FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR SHARE",[tenantId]);
      if(!tenant.rows[0])throw new AdminDeploymentHttpError(404,"TENANT_NOT_FOUND","Tenant is unavailable","/api/v1/admin/deployments");
      const result=await operation();await tx.query("COMMIT");return result;
    }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
  }
}
