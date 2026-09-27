import { Body, Controller, Get, Param, Post, Req, UseFilters } from "@nestjs/common";
import {
  RefundPaymentRequestSchema,
  ResolveDisputeRequestSchema,
  type ProblemDetails,
} from "@alterx/contracts";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { AdminBillingService } from "./admin-billing.service";
import { BillingExceptionFilter } from "./billing-exception.filter";
import { BillingHttpError } from "./problem";

@Controller("/api/v1/admin/billing")
@UseFilters(BillingExceptionFilter)
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

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
