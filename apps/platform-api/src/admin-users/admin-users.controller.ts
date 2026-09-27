import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Req } from "@nestjs/common";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { AdminUsersService } from "./admin-users.service";
import type { AdminUserActionView, AdminUserView } from "./types";

// Reading users exposes emails across tenants: support, security and admins
// only. Acting on a user: admins and security.
const readRoles = ["staff_admin", "staff_support", "staff_security"] as const;
const actRoles = ["staff_admin", "staff_security"] as const;
const BASE = "/api/v1/admin/users";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller(BASE)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequireStaffRole(...readRoles)
  list(): Promise<AdminUserView[]> {
    return this.users.list();
  }

  @Get(":userId")
  @RequireStaffRole(...readRoles)
  get(@Param("userId") userId: string): Promise<AdminUserView> {
    const instance = `${BASE}/${userId}`;
    return this.users.get(parseUserId(userId, instance), instance);
  }

  @Get(":userId/actions")
  @RequireStaffRole(...readRoles)
  actions(@Param("userId") userId: string): Promise<AdminUserActionView[]> {
    const instance = `${BASE}/${userId}/actions`;
    return this.users.actions(parseUserId(userId, instance), instance);
  }

  @Post(":userId/actions/suspend")
  @HttpCode(200)
  @RequireStaffRole(...actRoles)
  suspend(@Param("userId") userId: string, @Body() body: unknown, @Req() request: RbacRequest): Promise<AdminUserView> {
    const instance = `${BASE}/${userId}/actions/suspend`;
    return this.users.suspend(parseUserId(userId, instance), staffId(request, instance), parseReason(body, instance), instance);
  }

  @Post(":userId/actions/reinstate")
  @HttpCode(200)
  @RequireStaffRole(...actRoles)
  reinstate(@Param("userId") userId: string, @Req() request: RbacRequest): Promise<AdminUserView> {
    const instance = `${BASE}/${userId}/actions/reinstate`;
    return this.users.reinstate(parseUserId(userId, instance), staffId(request, instance), instance);
  }

  @Post(":userId/actions/revoke-sessions")
  @HttpCode(200)
  @RequireStaffRole(...actRoles)
  revokeSessions(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
  ): Promise<{ revoked: number }> {
    const instance = `${BASE}/${userId}/actions/revoke-sessions`;
    return this.users.revokeSessions(parseUserId(userId, instance), staffId(request, instance), parseReason(body, instance), instance);
  }
}

function problem(status: number, code: string, detail: string, instance: string): HttpException {
  return new HttpException(
    {
      type: `https://errors.alter.ai/${code.toLowerCase().replaceAll("_", "-")}`,
      title: code,
      status,
      detail,
      instance,
      error_code: code,
      trace_id: `trc_${randomUUID()}`,
      request_id: `req_${randomUUID()}`,
      retryable: false,
      field_errors: [],
      documentation_key: code.toLowerCase().replaceAll("_", "."),
    },
    status,
  );
}

function parseUserId(value: string, instance: string): string {
  if (!uuidPattern.test(value)) throw problem(400, "VALIDATION_FAILED", "Invalid userId", instance);
  return value;
}

function parseReason(body: unknown, instance: string): string {
  const reason = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) {
    throw problem(400, "VALIDATION_FAILED", "reason is required (1-1000 characters)", instance);
  }
  return reason.trim();
}

function staffId(request: RbacRequest, instance: string): string {
  const staff = request.staffActorContext;
  if (!staff) throw problem(401, "AUTHENTICATION_REQUIRED", "Authenticated staff actor required", instance);
  return staff.staff_user_id;
}
