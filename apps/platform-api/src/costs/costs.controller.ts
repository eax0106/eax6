import { Controller, Get, Headers, Param, Query, UseFilters } from "@nestjs/common";
import {
  ActorContext,
  RequirePermission,
  RequireStaffRole,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { CostsExceptionFilter } from "./costs-exception.filter";
import { CostsService } from "./costs.service";
import { StaffCostsService } from "./staff-costs.service";
import type { CostSummary, StaffCostSummary, WorkflowCost } from "./types";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;

/** D24: tenant cost routes answer with the billed price only. */
@Controller("/api/v1/costs")
@UseFilters(CostsExceptionFilter)
@RequireWorkspaceRole(...readRoles)
@RequirePermission("billing:read")
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  @Get("summary")
  summary(
    @Query() query: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<CostSummary> {
    return this.costs.summary(query, actor, traceparent);
  }
}

@Controller("/api/v1/workflows/:workflowId/costs")
@UseFilters(CostsExceptionFilter)
@RequireWorkspaceRole(...readRoles)
@RequirePermission("billing:read")
export class WorkflowCostsController {
  constructor(private readonly costs: CostsService) {}

  @Get()
  workflowCost(
    @Param("workflowId") workflowId: string,
    @Query() query: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<WorkflowCost> {
    return this.costs.workflowCost(workflowId, query, actor, traceparent);
  }
}

/** D24: the full breakdown, internal cost and margin included, for billing operations staff. */
@Controller("/api/v1/admin/tenants/:tenantId/costs")
@UseFilters(CostsExceptionFilter)
export class StaffCostsController {
  constructor(private readonly staffCosts: StaffCostsService) {}

  @Get()
  @RequireStaffRole("staff_billing_ops")
  summary(@Param("tenantId") tenantId: string, @Query() query: unknown): Promise<StaffCostSummary> {
    return this.staffCosts.summary(tenantId, query);
  }
}
