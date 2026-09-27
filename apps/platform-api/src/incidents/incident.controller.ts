import { Body, Controller, Get, Param, Post, Req, UseFilters } from "@nestjs/common";
import {
  CreateIncidentRequestSchema,
  IncidentApprovalRequestSchema,
  IncidentIdSchema,
  type ProblemDetails,
} from "@alterx/contracts";
import { z } from "zod";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { IncidentExceptionFilter } from "./incident-exception.filter";
import { IncidentService } from "./incident.service";
import { IncidentHttpError } from "./problem";

const readRoles = ["staff_admin", "staff_support", "staff_billing_ops", "staff_security"] as const;
const SetIncidentStatusRequestSchema = z
  .object({
    status: z.enum(["investigating", "monitoring", "resolved"]),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

@Controller("/api/v1/admin/incidents")
@UseFilters(IncidentExceptionFilter)
export class IncidentController {
  constructor(private readonly incidents: IncidentService) {}

  @Get()
  @RequireStaffRole(...readRoles)
  list() {
    return this.incidents.list();
  }

  @Get(":id")
  @RequireStaffRole(...readRoles)
  get(@Param("id") id: string) {
    return this.incidents.get(parse(IncidentIdSchema, id, `/api/v1/admin/incidents/${id}`));
  }

  @Post()
  @RequireStaffRole("staff_admin")
  create(@Body() body: unknown, @Req() request: RbacRequest) {
    const instance = "/api/v1/admin/incidents";
    return this.incidents.create(
      requireStaff(request, instance),
      parse(CreateIncidentRequestSchema, body, instance),
    );
  }

  @Post(":id/actions/request-publication")
  @RequireStaffRole("staff_admin")
  requestPublication(@Param("id") rawId: string, @Body() body: unknown, @Req() request: RbacRequest) {
    const instance = `/api/v1/admin/incidents/${rawId}/actions/request-publication`;
    return this.incidents.requestPublication(
      parse(IncidentIdSchema, rawId, instance),
      requireStaff(request, instance),
      parse(IncidentApprovalRequestSchema, body, instance),
    );
  }

  @Post(":id/actions/approve-publication")
  @RequireStaffRole("staff_admin")
  approvePublication(@Param("id") rawId: string, @Body() body: unknown, @Req() request: RbacRequest) {
    const instance = `/api/v1/admin/incidents/${rawId}/actions/approve-publication`;
    return this.incidents.approvePublication(
      parse(IncidentIdSchema, rawId, instance),
      requireStaff(request, instance),
      parse(IncidentApprovalRequestSchema, body, instance),
    );
  }

  @Post(":id/actions/set-status")
  @RequireStaffRole("staff_admin")
  setStatus(@Param("id") rawId: string, @Body() body: unknown, @Req() request: RbacRequest) {
    const instance = `/api/v1/admin/incidents/${rawId}/actions/set-status`;
    const input = parse(SetIncidentStatusRequestSchema, body, instance);
    return this.incidents.setStatus(
      parse(IncidentIdSchema, rawId, instance),
      requireStaff(request, instance),
      input.status,
      input.reason,
    );
  }

  @Post(":id/actions/publish")
  @RequireStaffRole("staff_admin")
  publish(@Param("id") rawId: string, @Req() request: RbacRequest) {
    const instance = `/api/v1/admin/incidents/${rawId}/actions/publish`;
    return this.incidents.publish(
      parse(IncidentIdSchema, rawId, instance),
      requireStaff(request, instance),
    );
  }
}

function requireStaff(request: RbacRequest, instance: string): string {
  if (!request.staffActorContext) {
    throw new IncidentHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated staff actor required", instance);
  }
  return request.staffActorContext.staff_user_id;
}

function parse<T>(schema: SafeParser<T>, value: unknown, instance: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields: ProblemDetails["field_errors"] = parsed.error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "value",
    message: issue.message,
  }));
  throw new IncidentHttpError(400, "VALIDATION_ERROR", "Request validation failed", instance, fields);
}

interface SafeParser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}
