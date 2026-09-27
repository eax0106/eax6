import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseFilters } from "@nestjs/common";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { StaffService } from "../staff";
import { AdminTenantsExceptionFilter } from "./admin-tenants-exception.filter";
import { AdminTenantsService } from "./admin-tenants.service";
import { AdminTenantHttpError } from "./problem";
import type {
  AdminTenantActionView,
  AdminTenantDetailView,
  AdminTenantView,
} from "./types";
import {
  parseEntitlementOverrideInput,
  parseProvisionTenantInput,
  parseSuspendTenantInput,
  parseTenantId,
} from "./validation";

const readRoles = ["staff_admin", "staff_support", "staff_billing_ops", "staff_security"] as const;

/**
 * No @Idempotent() on any mutating route here: that interceptor keys its
 * store on request.actorContext.tenant_id, which staff-plane requests
 * never carry (only staffActorContext) — it 400s immediately. Same reason
 * StaffController's own grant/revoke routes don't use it either. Real gap,
 * not silently worked around: this admin plane currently has no
 * idempotency-key replay protection, matching the JIT staff-access plane's
 * existing behavior.
 */
@Controller("/api/v1/admin/tenants")
@UseFilters(AdminTenantsExceptionFilter)
export class AdminTenantsController {
  constructor(
    private readonly tenants: AdminTenantsService,
    private readonly staff: StaffService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireStaffRole("staff_admin")
  provision(
    @Body() body: unknown,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantView> {
    const instance = "/api/v1/admin/tenants";
    return this.tenants.provision(
      requireStaff(request, instance).staff_user_id,
      parseProvisionTenantInput(body, instance),
    );
  }

  @Get()
  @RequireStaffRole(...readRoles)
  list(): Promise<AdminTenantView[]> {
    return this.tenants.list();
  }

  /**
   * staff_admin/staff_support must present the same active, scoped JIT
   * grant support-snapshot requires — otherwise this route was a direct
   * bypass of that gate (identical AdminTenantDetailView, no reason code,
   * no audit trail). staff_billing_ops/staff_security were never in
   * support-snapshot's role set and keep their existing ungated access;
   * this only closes the bypass for the two roles the grant exists to
   * restrict.
   */
  @Get(":tenantId")
  @RequireStaffRole(...readRoles)
  async get(
    @Param("tenantId") tenantId: string,
    @Headers("x-alter-support-grant") grantId: string | undefined,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantDetailView> {
    const instance = `/api/v1/admin/tenants/${tenantId}`;
    const id = parseTenantId(tenantId, instance);
    await this.requireTenantRead(request, grantId, id, instance);
    return this.tenants.get(id);
  }

  /**
   * The tenant's staff action history, shown as its timeline in the console.
   * Same gate as get(): staff_admin/staff_support need an active scoped grant.
   */
  @Get(":tenantId/actions")
  @RequireStaffRole(...readRoles)
  async actions(
    @Param("tenantId") tenantId: string,
    @Headers("x-alter-support-grant") grantId: string | undefined,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantActionView[]> {
    const instance = `/api/v1/admin/tenants/${tenantId}/actions`;
    const id = parseTenantId(tenantId, instance);
    await this.requireTenantRead(request, grantId, id, instance);
    return this.tenants.actions(id);
  }

  private async requireTenantRead(
    request: RbacRequest,
    grantId: string | undefined,
    tenantId: string,
    instance: string,
  ): Promise<void> {
    const staff = requireStaff(request, instance);
    if (staff.roles.some((role) => role === "staff_admin" || role === "staff_support")) {
      if (!grantId?.startsWith("jit_")) {
        throw new AdminTenantHttpError(
          403,
          "ACTIVE_SUPPORT_GRANT_REQUIRED",
          "Active scoped support grant required",
          instance,
        );
      }
      await this.staff.requireAccess(grantId, staff.staff_user_id, tenantId, "tenant:read");
    }
  }

  @Get(":tenantId/support-snapshot")
  @RequireStaffRole("staff_admin", "staff_support")
  async supportSnapshot(
    @Param("tenantId") tenantId: string,
    @Headers("x-alter-support-grant") grantId: string | undefined,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantDetailView> {
    const instance = `/api/v1/admin/tenants/${tenantId}/support-snapshot`;
    const id = parseTenantId(tenantId, instance);
    if (!grantId?.startsWith("jit_")) {
      throw new AdminTenantHttpError(
        403,
        "ACTIVE_SUPPORT_GRANT_REQUIRED",
        "Active scoped support grant required",
        instance,
      );
    }
    await this.staff.requireAccess(
      grantId,
      requireStaff(request, instance).staff_user_id,
      id,
      "tenant:read",
    );
    return this.tenants.get(id);
  }

  @Post(":tenantId/actions/suspend")
  @HttpCode(200)
  @RequireStaffRole("staff_admin")
  suspend(
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantView> {
    const instance = `/api/v1/admin/tenants/${tenantId}/actions/suspend`;
    const id = parseTenantId(tenantId, instance);
    return this.tenants.suspend(
      id,
      requireStaff(request, instance).staff_user_id,
      parseSuspendTenantInput(body, instance),
    );
  }

  @Post(":tenantId/actions/reinstate")
  @HttpCode(200)
  @RequireStaffRole("staff_admin")
  reinstate(
    @Param("tenantId") tenantId: string,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantView> {
    const instance = `/api/v1/admin/tenants/${tenantId}/actions/reinstate`;
    const id = parseTenantId(tenantId, instance);
    return this.tenants.reinstate(id, requireStaff(request, instance).staff_user_id);
  }

  @Post(":tenantId/entitlements")
  @HttpCode(200)
  @RequireStaffRole("staff_admin", "staff_billing_ops")
  overrideEntitlement(
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
  ): Promise<AdminTenantDetailView> {
    const instance = `/api/v1/admin/tenants/${tenantId}/entitlements`;
    const id = parseTenantId(tenantId, instance);
    return this.tenants.overrideEntitlement(
      id,
      requireStaff(request, instance).staff_user_id,
      parseEntitlementOverrideInput(body, instance),
    );
  }
}

function requireStaff(
  request: RbacRequest,
  instance: string,
): NonNullable<RbacRequest["staffActorContext"]> {
  const staff = request.staffActorContext;
  if (!staff) {
    throw new AdminTenantHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated staff actor required",
      instance,
    );
  }
  return staff;
}
