import { Body, Controller, Get, Headers, Optional, Param, Post, Req, UseFilters } from "@nestjs/common";
import {
  BillingOperationsTenantSchema, StaffBillingReasonRequestSchema, StaffRunCreditRequestSchema,
  RefundPaymentRequestSchema,
  ResolveDisputeRequestSchema,
  type ProblemDetails,
} from "@alterx/contracts";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import {AdminBillingOperationsService} from "./admin-billing-operations.service";
import { AdminBillingService } from "./admin-billing.service";
import { BillingExceptionFilter } from "./billing-exception.filter";
import { BillingHttpError } from "./problem";

@Controller("/api/v1/admin/billing")
@UseFilters(BillingExceptionFilter)
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService,@Optional() private readonly operations?:AdminBillingOperationsService) {}

  @Get("issues/:tenantId/history")
  @RequireStaffRole("staff_admin","staff_billing_ops")
  history(@Param("tenantId") tenant:string,@Req() request:RbacRequest){return this.requireOperations().history(parse(BillingOperationsTenantSchema,tenant,"/api/v1/admin/billing/issues"),requireStaff(request,"/api/v1/admin/billing/issues"));}

  @Post("issues/:tenantId/actions/grant-credits")
  @RequireStaffRole("staff_admin","staff_billing_ops")
  grant(@Param("tenantId") tenant:string,@Body() body:unknown,@Headers("if-match") revision:string|undefined,@Req() request:RbacRequest){return this.action(tenant,{...parse(StaffRunCreditRequestSchema,body,"/api/v1/admin/billing/issues"),action:"grant_credits"},revision,request);}

  @Post("issues/:tenantId/actions/retry")
  @RequireStaffRole("staff_admin","staff_billing_ops")
  retry(@Param("tenantId") tenant:string,@Body() body:unknown,@Headers("if-match") revision:string|undefined,@Req() request:RbacRequest){return this.action(tenant,{...parse(StaffBillingReasonRequestSchema,body,"/api/v1/admin/billing/issues"),action:"retry"},revision,request);}

  @Post("issues/:tenantId/actions/resolve")
  @RequireStaffRole("staff_admin","staff_billing_ops")
  resolve(@Param("tenantId") tenant:string,@Body() body:unknown,@Headers("if-match") revision:string|undefined,@Req() request:RbacRequest){return this.action(tenant,{...parse(StaffBillingReasonRequestSchema,body,"/api/v1/admin/billing/issues"),action:"resolve"},revision,request);}

  private action(tenant:string,body:unknown,revision:string|undefined,request:RbacRequest){return this.requireOperations().apply(parse(BillingOperationsTenantSchema,tenant,"/api/v1/admin/billing/issues"),requireStaff(request,"/api/v1/admin/billing/issues"),body,revision);}
  private requireOperations():AdminBillingOperationsService{if(!this.operations)throw new BillingHttpError(503,"BILLING_OPERATIONS_UNAVAILABLE","Billing operations are unavailable","/api/v1/admin/billing/issues");return this.operations;}

  @Get("issues")
  @RequireStaffRole("staff_admin", "staff_billing_ops")
  issues() {
    return this.billing.listIssues();
  }

  @Post("refunds")
  @RequireStaffRole("staff_admin", "staff_billing_ops")
  refund(@Body() body: unknown, @Req() request: RbacRequest) {
    const instance = "/api/v1/admin/billing/refunds";
    return this.billing.refund(
      requireStaff(request, instance),
      parse(RefundPaymentRequestSchema, body, instance),
    );
  }

  @Post("disputes/:disputeRef/actions/resolve")
  @RequireStaffRole("staff_admin", "staff_billing_ops")
  resolveDispute(
    @Param("disputeRef") disputeRef: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
  ) {
    const instance = `/api/v1/admin/billing/disputes/${disputeRef}/actions/resolve`;
    if (disputeRef.trim().length === 0 || disputeRef.length > 256) {
      throw invalid(instance, [{ field: "disputeRef", message: "Invalid dispute reference" }]);
    }
    return this.billing.resolveDispute(
      requireStaff(request, instance),
      disputeRef,
      parse(ResolveDisputeRequestSchema, body, instance),
    );
  }
}

function requireStaff(request: RbacRequest, instance: string): string {
  if (!request.staffActorContext) {
    throw new BillingHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated staff actor required",
      instance,
    );
  }
  return request.staffActorContext.staff_user_id;
}

function parse<T>(schema: SafeParser<T>, value: unknown, instance: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalid(
    instance,
    parsed.error.issues.map((issue) => ({
      field: issue.path.map(String).join(".") || "body",
      message: issue.message,
    })),
  );
}

interface SafeParser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

function invalid(
  instance: string,
  fields: ProblemDetails["field_errors"],
): BillingHttpError {
  return new BillingHttpError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    instance,
    fields,
  );
}
