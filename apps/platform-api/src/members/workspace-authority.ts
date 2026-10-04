import type { PoolClient } from "pg";
import { z } from "zod";
import type { ActorContext } from "../rbac/types";
import { workspaceRoles } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";
import { bareWorkspaceId } from "../workspaces/workspace-id";

export const FixedWorkspaceRole = z.enum(workspaceRoles);
export const memberInstance = "/api/v1/members";

export function memberError(status: number, code: string, detail: string): never {
  throw new PlatformHttpError(status, code, detail, memberInstance);
}

export function workspaceUuid(value: string): string {
  return bareWorkspaceId(value) ?? memberError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
}

/** Lock one workspace before membership/invitation writes, including last-admin checks. */
export async function lockManagedWorkspace(client: PoolClient, actor: ActorContext, workspaceId: string): Promise<string | null> {
  const workspace = await client.query<{ organization: string | null }>(
    `SELECT t.identity_org_ref AS organization FROM workspaces w
       JOIN tenants t ON t.id=w.tenant_id
      WHERE w.tenant_id=$1 AND w.id=$2 AND w.status='active' AND t.status='active'
      FOR UPDATE OF w`, [actor.tenant_id, workspaceId]);
  if (!workspace.rows[0]) memberError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  const authority = await client.query(
    `SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=$1 AND tm.user_id=$2
      AND (tm.role='owner' OR EXISTS (SELECT 1 FROM workspace_members wm
        WHERE wm.tenant_id=$1 AND wm.workspace_id=$3 AND wm.user_id=$2 AND wm.role='admin'))`,
    [actor.tenant_id, actor.user_id, workspaceId]);
  if (!authority.rowCount) memberError(403, "MEMBER_MANAGEMENT_FORBIDDEN", "Workspace admin or tenant owner required");
  return workspace.rows[0].organization;
}
