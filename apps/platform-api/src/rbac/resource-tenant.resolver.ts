import type { PlatformDb } from "../signup/platform-db";
import { bareWorkspaceId } from "../workspaces/workspace-id";
import type { RbacRequest } from "./types";

export interface ResourceTenantResolver {
  resolveTenantId(request: RbacRequest): Promise<string | undefined>;
}

/**
 * The one capability WorkspaceResourceTenantResolver needs from PlatformDb
 * -- deliberately narrower and non-generic (PlatformDb.queryTenant is
 * generic over an arbitrary QueryResultRow) so callers/tests don't need to
 * juggle that generic just to satisfy this one fixed-shape lookup.
 */
export interface WorkspaceTenantLookup {
  queryWorkspaceTenant(
    actorTenantId: string,
    workspaceId: string,
  ): Promise<string | undefined>;
}

// ENGINE-FIX-P3-21 (Wave 3 item 5). Guaranteed never to equal a real
// tenant_id (every real one is `ten_<uuidv7>` prefixed) -- returned when a
// workspaceId param was present but did not resolve to a workspace the
// requesting actor's own tenant can see. RbacGuard's plain !== comparison
// then denies, instead of the previous behavior of returning `undefined`
// (which RbacGuard treats as "nothing to check").
const RESOURCE_NOT_FOUND_FOR_ACTOR = "__resource-not-found-for-actor__";

/**
 * Was RequestParamTenantResolver: for a workspaceId route param it looked
 * the tenant up in an in-memory Map that rbac.module.ts's production
 * wiring constructed with zero entries (`new RequestParamTenantResolver()`)
 * -- meaning RbacGuard's tenant-mismatch check silently never fired for any
 * of the 24 controllers gated by @RequireWorkspaceRole. Real bug, not a
 * cosmetic one: an actor could pass any workspaceId in the URL and the
 * "does this workspace belong to your tenant" check just never ran.
 *
 * Now resolves the workspace's real owning tenant with a real query,
 * scoped to the REQUESTING ACTOR's own tenant (the same RLS mechanism
 * every other tenant-scoped query in this app already uses via
 * PlatformDb.queryTenant, not a separate bypass-RLS read). If the
 * workspace belongs to a different tenant, RLS filters the row out and
 * this legitimately sees zero rows back -- "doesn't exist" and "isn't
 * yours" collapse to the same signal, which is correct here and avoids
 * leaking whether a workspace ID that isn't the caller's even exists.
 *
 * A tenantId/tenant_id route param is handled differently: there the
 * resource named by the URL already IS the tenant, so returning it
 * directly (for RbacGuard to compare against the actor's own tenant_id)
 * is the real check, not a lookup -- unlike the workspace case, there was
 * nothing to fix here.
 */
export class WorkspaceResourceTenantResolver implements ResourceTenantResolver {
  constructor(private readonly db: WorkspaceTenantLookup) {}

  async resolveTenantId(request: RbacRequest): Promise<string | undefined> {
    const params = request.params ?? {};
    const directTenantId = params.tenantId ?? params.tenant_id;
    if (directTenantId) {
      return directTenantId;
    }

    const workspaceId = params.workspaceId ?? params.workspace_id;
    if (!workspaceId) {
      return undefined;
    }

    const actorTenantId = request.actorContext?.tenant_id;
    if (!actorTenantId) {
      return undefined;
    }

    const found = await this.db.queryWorkspaceTenant(actorTenantId, workspaceId);
    return found ?? RESOURCE_NOT_FOUND_FOR_ACTOR;
  }
}

/** Real production WorkspaceTenantLookup, adapting PlatformDb's generic
 * queryTenant to this file's narrower, fixed-shape contract. */
export class PlatformDbWorkspaceTenantLookup implements WorkspaceTenantLookup {
  constructor(private readonly db: Pick<PlatformDb, "queryTenant">) {}

  async queryWorkspaceTenant(
    actorTenantId: string,
    workspaceId: string,
  ): Promise<string | undefined> {
    // A route may name the workspace by its bare UUID or its ws_ form; any
    // other string names no workspace (and would make Postgres fail the
    // uuid cast, answering 500 instead of a denial).
    const id = bareWorkspaceId(workspaceId);
    if (id === undefined) {
      return undefined;
    }
    const rows = await this.db.queryTenant<{ readonly tenant_id: string }>(
      actorTenantId,
      "SELECT tenant_id FROM workspaces WHERE id = $1",
      [id],
    );
    return rows[0]?.tenant_id;
  }
}
