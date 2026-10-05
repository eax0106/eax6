import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import { RequireStaffRole } from "../rbac/decorators";
import { EtagResponseInterceptor } from "../concurrency";
import type { RbacRequest } from "../rbac/types";
import { AdminPolicyExceptionFilter } from "./admin-policy-exception.filter";
import { AdminPolicyService } from "./admin-policy.service";
import { AdminPolicyHttpError } from "./problem";
import type {
  PlanDefinitionAuditView,
  PlanDefinitionView,
  PlanPolicyView,
} from "./types";
import {
  parseDeletePlanDefinitionInput,
  parseHistoryLimit,
  parsePlanName,
  parseUpsertPlanDefinitionInput,
} from "./validation";

const readRoles = ["staff_admin", "staff_support", "staff_billing_ops", "staff_security"] as const;
const writeRoles = ["staff_admin", "staff_billing_ops"] as const;

/**
 * Global plan policy: the staff-authored layer that supplies plan limit
 * defaults ahead of the deployed ConfigProvider. Distinct from
 * POST /api/v1/admin/tenants/:tenantId/entitlements, which is a per-tenant
 * override sitting on top of whatever this layer resolves to.
 *
 * No @Idempotent() here for the same reason as AdminTenantsController: that
 * interceptor keys on request.actorContext.tenant_id, which staff-plane
 * requests never carry. PUT is naturally idempotent; DELETE 404s on repeat.
 */
@Controller("/api/v1/admin/policy/plans")
@UseFilters(AdminPolicyExceptionFilter)
export class AdminPolicyController {
  constructor(private readonly policy: AdminPolicyService) {}

  @Get()
  @RequireStaffRole(...readRoles)
  listDefinitions(): Promise<PlanDefinitionView[]> {
    return this.policy.listDefinitions();
  }

  @Get(":plan")
  @UseInterceptors(EtagResponseInterceptor)
  @RequireStaffRole(...readRoles)
  getPolicy(@Param("plan") plan: string): Promise<PlanPolicyView> {
    const instance = `/api/v1/admin/policy/plans/${plan}`;
    return this.policy.getPolicy(parsePlanName(plan, instance));
  }

  @Get(":plan/history")
  @RequireStaffRole(...readRoles)
  history(
    @Param("plan") plan: string,
    @Query("limit") limit?: string,
  ): Promise<PlanDefinitionAuditView[]> {
    const instance = `/api/v1/admin/policy/plans/${plan}/history`;
    return this.policy.history(
      parsePlanName(plan, instance),
      parseHistoryLimit(limit, instance),
    );
  }

  @Put(":plan")
  @UseInterceptors(EtagResponseInterceptor)
  @HttpCode(200)
  @RequireStaffRole(...writeRoles)
  upsert(
    @Param("plan") plan: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
    @Headers("if-match") ifMatch?: string,
  ): Promise<PlanDefinitionView> {
    const instance = `/api/v1/admin/policy/plans/${plan}`;
    return this.policy.upsert(
      parsePlanName(plan, instance),
      requireStaff(request, instance).staff_user_id,
      parseUpsertPlanDefinitionInput(body, instance),
      ifMatch,
    );
  }

  @Delete(":plan")
  @HttpCode(204)
  @RequireStaffRole(...writeRoles)
  remove(
    @Param("plan") plan: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
    @Headers("if-match") ifMatch?: string,
  ): Promise<void> {
    const instance = `/api/v1/admin/policy/plans/${plan}`;
    return this.policy.remove(
      parsePlanName(plan, instance),
      requireStaff(request, instance).staff_user_id,
      parseDeletePlanDefinitionInput(body, instance),
      ifMatch,
    );
  }
}

function requireStaff(
  request: RbacRequest,
  instance: string,
): NonNullable<RbacRequest["staffActorContext"]> {
  const staff = request.staffActorContext;
  if (!staff) {
    throw new AdminPolicyHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated staff actor required",
      instance,
    );
  }
  return staff;
}
