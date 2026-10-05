import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import { DeploymentAdminActionRequestSchema, TenantDeploymentListRequestSchema } from "@alterx/contracts";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { AdminDeploymentService } from "./admin-deployment.service";
import { AdminDeploymentHttpError } from "./problem";

@Controller("/api/v1/admin/deployments")
export class AdminDeploymentController {
  constructor(private readonly deployments: AdminDeploymentService) {}

  @Get()
  @RequireStaffRole("staff_admin")
  list(@Query() query:unknown,@Req() request:RbacRequest,@Headers("traceparent") traceparent:string|undefined) {
    const parsed=TenantDeploymentListRequestSchema.safeParse(query);
    if(!parsed.success)throw new AdminDeploymentHttpError(400,"DEPLOYMENT_ADMIN_VALIDATION_FAILED","A tenant identifier is required","/api/v1/admin/deployments");
    const actor=request.staffActorContext?.staff_user_id;
    if(!actor)throw new AdminDeploymentHttpError(401,"AUTHENTICATION_REQUIRED","Authenticated staff actor required","/api/v1/admin/deployments");
    return this.deployments.list(parsed.data.tenant_id,actor,traceparent);
  }

  @Post(":deploymentId/actions/apply")
  @RequireStaffRole("staff_admin")
  apply(
    @Param("deploymentId") deploymentId: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    const instance = `/api/v1/admin/deployments/${deploymentId}/actions/apply`;
    const parsed = DeploymentAdminActionRequestSchema.safeParse(body);
    if (!parsed.success || parsed.data.deployment_id !== deploymentId) {
      throw new AdminDeploymentHttpError(
        400,
        "DEPLOYMENT_ADMIN_VALIDATION_FAILED",
        "Body deployment_id must match route deploymentId",
        instance,
      );
    }
    const staffUserId = request.staffActorContext?.staff_user_id;
    if (!staffUserId) {
      throw new AdminDeploymentHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated staff actor required", instance);
    }
    if (!ifMatch?.trim()) throw new AdminDeploymentHttpError(428,"PRECONDITION_REQUIRED","If-Match is required",instance);
    return this.deployments.apply(parsed.data, staffUserId, traceparent, ifMatch);
  }
}
