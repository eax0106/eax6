import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { IdentityService } from "../identity/identity.service";
import { permissionsForRoles } from "./permissions";
import { PlatformDb } from "../signup/platform-db";
import type { RbacRequest } from "./types";

interface RoleRow {
  role: string;
  workspaceId: string | null;
}

/**
 * Populates request.actorContext ahead of RbacGuard. This used to be
 * SignupActorContextMiddleware (a NestJS middleware, i.e. Fastify onRequest
 * phase) -- Fastify gave middleware and guards different request object
 * references here, so a plain `request.actorContext = ...` assignment in
 * middleware never survived through to the guard phase, and every
 * RequireWorkspaceRole/RequireTenantRole check failed closed with
 * RBAC_ROLE_DENIED regardless of what roles the user actually had. Guards
 * all run in the same phase against the same request object, so this fixes
 * it structurally rather than chasing the Fastify request-identity mismatch
 * further. Always returns true -- an absent/invalid token just leaves
 * actorContext unset, and RbacGuard (registered after this one) is what
 * actually denies the request.
 */
@Injectable()
export class ActorContextGuard implements CanActivate {
  constructor(
    private readonly identityService: IdentityService,
    private readonly db: PlatformDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RbacRequest & { headers: { cookie?: string } }>();
    const accessToken = readCookie(request.headers.cookie, "alter_access");
    if (!accessToken) {
      return true;
    }

    try {
      const session = await this.identityService.authenticateAccessToken(accessToken);
      const tenantRoles = await this.db.queryTenant<RoleRow>(
        session.tenantId,
        `SELECT role, NULL::uuid AS "workspaceId"
           FROM tenant_members
          WHERE tenant_id = $1 AND user_id = $2`,
        [session.tenantId, session.userId],
      );
      // D2: no workspace role is granted in a workspace pending deletion, so
      // its workspace-scoped routes (runs, triggers, settings) are refused
      // until it is restored.
      const workspaceRoles = await this.db.queryTenant<RoleRow>(
        session.tenantId,
        `SELECT m.role, m.workspace_id AS "workspaceId"
           FROM workspace_members m
           JOIN workspaces w ON w.id = m.workspace_id AND w.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.user_id = $2
            AND w.status <> 'pending_deletion'
          ORDER BY m.created_at ASC, m.workspace_id ASC`,
        [session.tenantId, session.userId],
      );
      request.actorContext = {
        user_id: session.userId,
        tenant_id: session.tenantId,
        ...(workspaceRoles[0]?.workspaceId
          ? { workspace_id: workspaceRoles[0].workspaceId }
          : {}),
        roles: [...tenantRoles, ...workspaceRoles].map((row) => row.role),
        // ENGINE-FIX-P5-1: structured per-workspace bindings so RbacGuard
        // can check a workspace role against the SPECIFIC workspace a route
        // addresses, instead of the flat any-workspace union.
        workspaceRoles: workspaceRoles
          .filter((row): row is RoleRow & { workspaceId: string } =>
            typeof row.workspaceId === "string" && row.workspaceId.length > 0)
          .map((row) => ({ workspaceId: row.workspaceId, role: row.role })),
        // ENGINE-FIX-P3-7: was hardcoded to [], which -- combined with
        // RbacGuard comparing every route's declared @RequirePermission(...)
        // against this array -- denied all 101 @RequirePermission routes
        // unconditionally regardless of role. Now derived from the roles
        // just queried above, via the table in ./permissions.ts.
        permissions: permissionsForRoles([...tenantRoles, ...workspaceRoles].map((row) => row.role)),
        session_id: session.id,
        auth_time: Math.floor(session.createdAt.getTime() / 1000),
      };
    } catch (error) {
      // RbacGuard returns the standard denial for invalid/revoked/expired
      // sessions; logged so a real failure here is never silently
      // indistinguishable from "not logged in".
      console.error("ActorContextGuard failed:", error);
    }
    return true;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
