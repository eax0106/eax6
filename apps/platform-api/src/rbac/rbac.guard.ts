import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { WorkspaceLookupUnavailableError } from "./param-workspace.resolver";
import type { ResourceWorkspaceResolver } from "./param-workspace.resolver";
import { RbacDeniedError, rbacProblem } from "./problem";
import {
  permissionsMetadataKey,
  publicRouteMetadataKey,
  tenantRolesMetadataKey,
  workspaceRolesMetadataKey,
  staffRolesMetadataKey,
} from "./rbac.metadata";
import type { ResourceTenantResolver } from "./resource-tenant.resolver";
import type { RbacRequest, StaffRole, TenantRole, WorkspaceRole } from "./types";
import { staffRoleAllows, tenantRoleAllows, workspaceRoleAllows } from "./types";

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resourceTenantResolver: ResourceTenantResolver,
    private readonly workspaceResolver: ResourceWorkspaceResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(publicRouteMetadataKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const tenantRoles = this.reflector.getAllAndOverride<TenantRole[]>(
      tenantRolesMetadataKey,
      [context.getHandler(), context.getClass()],
    );
    const workspaceRoles = this.reflector.getAllAndOverride<WorkspaceRole[]>(
      workspaceRolesMetadataKey,
      [context.getHandler(), context.getClass()],
    );
    const permissions = this.reflector.getAllAndOverride<string[]>(
      permissionsMetadataKey,
      [context.getHandler(), context.getClass()],
    );
    const staffRoles = this.reflector.getAllAndOverride<StaffRole[]>(staffRolesMetadataKey, [context.getHandler(), context.getClass()]);

    const request = context.switchToHttp().getRequest<RbacRequest & { raw?: Pick<RbacRequest, "staffActorContext"> }>();
    // Nest middleware runs on the raw request; Fastify wraps it before guards.
    if (!request.staffActorContext && request.raw?.staffActorContext) request.staffActorContext = request.raw.staffActorContext;
    const actorContext = request.actorContext;
    if (staffRoles?.length) {
      const staff = request.staffActorContext;
      if (!staff || !staffRoles.some((required) => staff.roles.some((actual) => staffRoleAllows(actual, required)))) throw deny("RBAC_ROLE_DENIED", request.url);
      return true;
    }

    if (!actorContext || (!tenantRoles?.length && !workspaceRoles?.length)) {
      throw deny("RBAC_ROLE_DENIED", request.url);
    }

    const targetTenantId = await this.resourceTenantResolver.resolveTenantId(request);
    if (targetTenantId && actorContext.tenant_id !== targetTenantId) {
      throw deny("RBAC_TENANT_MISMATCH", request.url);
    }

    const hasTenantRole =
      tenantRoles?.some((required) =>
        actorContext.roles.some((actual) => tenantRoleAllows(actual, required)),
      ) ?? false;

    // ENGINE-FIX-P5-1: a @RequireWorkspaceRole route that addresses a
    // specific workspace (direct workspaceId param, or a projectId resolved
    // to its owning workspace) requires the role IN THAT WORKSPACE -- the
    // flat any-workspace union in actorContext.roles must not satisfy it.
    // Routes with no resolvable workspace (collections, families whose
    // ownership lives behind other lookups) keep the legacy flat check and
    // are documented as such.
    let workspaceRequirementSatisfied = false;
    if (workspaceRoles?.length) {
      let targetWorkspaceId: string | undefined;
      try {
        targetWorkspaceId =
          await this.workspaceResolver.resolveWorkspaceId(request);
      } catch (error: unknown) {
        if (error instanceof WorkspaceLookupUnavailableError) {
          throw deny("RBAC_WORKSPACE_UNRESOLVABLE", request.url);
        }
        throw error;
      }
      if (targetWorkspaceId === undefined) {
        workspaceRequirementSatisfied = workspaceRoles.some((required) =>
          actorContext.roles.some((actual) =>
            workspaceRoleAllows(actual, required),
          ),
        );
      } else {
        const binding = actorContext.workspaceRoles?.find(
          (candidate) => candidate.workspaceId === targetWorkspaceId,
        );
        workspaceRequirementSatisfied =
          binding !== undefined &&
          workspaceRoles.some((required) =>
            workspaceRoleAllows(binding.role, required),
          );
        if (!workspaceRequirementSatisfied) {
          throw deny("RBAC_WORKSPACE_ROLE_DENIED", request.url);
        }
      }
    }

    if (!hasTenantRole && !workspaceRequirementSatisfied) {
      throw deny("RBAC_ROLE_DENIED", request.url);
    }

    if (
      permissions?.length &&
      !permissions.every((permission) =>
        actorContext.permissions.includes(permission),
      )
    ) {
      throw deny("RBAC_PERMISSION_DENIED", request.url);
    }

    return true;
  }
}

function deny(
  errorCode:
    | "RBAC_PERMISSION_DENIED"
    | "RBAC_TENANT_MISMATCH"
    | "RBAC_ROLE_DENIED"
    | "RBAC_WORKSPACE_ROLE_DENIED"
    | "RBAC_WORKSPACE_UNRESOLVABLE",
  instance = "unknown",
): RbacDeniedError {
  return new RbacDeniedError(rbacProblem(errorCode, instance));
}
