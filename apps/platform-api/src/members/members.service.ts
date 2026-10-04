import type { AuditEventHandler } from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import { z } from "zod";
import { computeEtag, ConcurrencyHttpError, ifMatchIncludes } from "../concurrency";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { streamRevocationBus, type StreamRevocationBus } from "../streaming/revocation";
import { FixedWorkspaceRole, lockManagedWorkspace, memberError, memberInstance, workspaceUuid } from "./workspace-authority";
import type { InvitationView, WorkspaceInvitationsService } from "./workspace-invitations.service";

export interface MemberView {
  id: string; tenantId: string; workspaceId: string; userId: string; role: string;
  scope: "workspace"; email: string; name: string | null; tenantOwner: boolean; etag: string;
}
type MemberRow = Omit<MemberView, "etag">;
const selectMember = `SELECT m.id,m.tenant_id AS "tenantId",m.workspace_id AS "workspaceId",m.user_id AS "userId",m.role,
  'workspace' AS scope,u.email,u.display_name AS name,(tm.role='owner') AS "tenantOwner"
  FROM workspace_members m JOIN users u ON u.id=m.user_id
  JOIN tenant_members tm ON tm.tenant_id=m.tenant_id AND tm.user_id=m.user_id`;

export class MembersService {
  constructor(private readonly db: PlatformDb, private readonly revocations: StreamRevocationBus = streamRevocationBus,
    private readonly audit?: AuditEventHandler, private readonly invitations?: WorkspaceInvitationsService) {}

  async list(actor: ActorContext, workspaceId?: string): Promise<MemberView[]> {
    const workspace = workspaceId ?? actor.workspace_id ?? (await this.db.queryTenant<{ id: string }>(actor.tenant_id,
      `SELECT w.id FROM workspaces w WHERE w.tenant_id=$1 AND w.status='active' AND
        (EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND tm.role='owner') OR
         EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.tenant_id=$1 AND wm.workspace_id=w.id AND wm.user_id=$2)) ORDER BY w.created_at,w.id LIMIT 1`,
      [actor.tenant_id, actor.user_id]))[0]?.id;
    if (!workspace) return [];
    const target = workspaceUuid(workspace);
    return this.db.withTenant(actor.tenant_id, async client => {
      const access = await client.query(`SELECT 1 FROM workspaces w WHERE w.tenant_id=$1 AND w.id=$3 AND w.status='active' AND
        (EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND tm.role='owner') OR
         EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.tenant_id=$1 AND wm.workspace_id=$3 AND wm.user_id=$2))`, [actor.tenant_id, actor.user_id, target]);
      if (!access.rowCount) memberError(403, "WORKSPACE_ACCESS_FORBIDDEN", "Workspace membership required");
      const rows = await client.query<MemberRow>(selectMember + " WHERE m.tenant_id=$1 AND m.workspace_id=$2 ORDER BY u.display_name NULLS LAST,u.email,m.id", [actor.tenant_id, target]);
      return rows.rows.map(memberView);
    });
  }

  async invite(actor: ActorContext, body: unknown): Promise<InvitationView> {
    if (!this.invitations) memberError(503, "INVITATIONS_UNAVAILABLE", "Invitation delivery is unavailable");
    return this.invitations.create(actor, body);
  }

  async updateRole(actor: ActorContext, memberId: string, body: unknown, ifMatch: string | undefined): Promise<MemberView> {
    const parsed = z.object({ role: FixedWorkspaceRole }).strict().safeParse(body);
    if (!parsed.success) memberError(400, "INVALID_MEMBER_ROLE", "One fixed workspace role required");
    const row = await this.db.withTenant(actor.tenant_id, async client => {
      const current = await this.lockMember(client, actor, memberId);
      assertMutable(current, ifMatch);
      if (current.role === "admin" && parsed.data.role !== "admin") await assertOtherAdmin(client, current);
      await client.query("UPDATE workspace_members SET role=$3 WHERE tenant_id=$1 AND id=$2", [actor.tenant_id, current.id, parsed.data.role]);
      await this.record(actor, current, "workspace.member.role_changed", { before: current.role, after: parsed.data.role });
      return memberView({ ...current, role: parsed.data.role });
    });
    this.revocations.publish({ tenantId: actor.tenant_id, userId: row.userId });
    return row;
  }

  async remove(actor: ActorContext, memberId: string, scope: string, ifMatch?: string): Promise<void> {
    if (scope !== "workspace") memberError(400, "INVALID_MEMBER_SCOPE", "Only workspace memberships can be removed here");
    const removed = await this.db.withTenant(actor.tenant_id, async client => {
      const row = await this.lockMember(client, actor, memberId);
      assertMutable(row, ifMatch);
      if (row.role === "admin") await assertOtherAdmin(client, row);
      await client.query("DELETE FROM workspace_members WHERE tenant_id=$1 AND id=$2", [actor.tenant_id, row.id]);
      await this.record(actor, row, "workspace.member.removed", { role: row.role });
      return row;
    });
    this.revocations.publish({ tenantId: actor.tenant_id, userId: removed.userId });
  }

  private async lockMember(client: PoolClient, actor: ActorContext, id: string): Promise<MemberRow> {
    if (!z.string().uuid().safeParse(id).success) memberError(404, "MEMBER_NOT_FOUND", "Member not found");
    const hint = await client.query<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members WHERE tenant_id=$1 AND id=$2", [actor.tenant_id, id]);
    if (!hint.rows[0]) memberError(404, "MEMBER_NOT_FOUND", "Member not found");
    await lockManagedWorkspace(client, actor, hint.rows[0].workspace_id);
    const result = await client.query<MemberRow>(selectMember + " WHERE m.tenant_id=$1 AND m.id=$2 FOR UPDATE OF m", [actor.tenant_id, id]);
    return result.rows[0] ?? memberError(404, "MEMBER_NOT_FOUND", "Member not found");
  }

  private async record(actor: ActorContext, member: MemberRow, action: string, context: Record<string, string>): Promise<void> {
    if (!this.audit) memberError(503, "MEMBERS_AUDIT_UNAVAILABLE", "Membership audit is unavailable");
    await this.audit.recordEvent({ tenant_id: actor.tenant_id, actor_type: "user", actor_ref: actor.user_id, action,
      target_type: "workspace_member", target_ref: member.id, result: "success", reason_code: "",
      context_json: JSON.stringify({ workspaceId: member.workspaceId, ...context }), occurred_at: new Date().toISOString() });
  }
}

function memberView(row: MemberRow): MemberView { return { ...row, etag: computeEtag(row) }; }
function assertMutable(row: MemberRow, ifMatch: string | undefined): void {
  if (row.tenantOwner) memberError(409, "TENANT_OWNER_IMMUTABLE", "Tenant owner's workspace membership cannot be changed");
  if (!ifMatch) throw new ConcurrencyHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", memberInstance);
  if (!ifMatchIncludes(ifMatch, computeEtag(row))) throw new ConcurrencyHttpError(412, "ETAG_MISMATCH", "Membership changed since it was read", memberInstance);
}
async function assertOtherAdmin(client: PoolClient, row: MemberRow): Promise<void> {
  const other = await client.query("SELECT 1 FROM workspace_members WHERE tenant_id=$1 AND workspace_id=$2 AND role='admin' AND id<>$3 LIMIT 1", [row.tenantId, row.workspaceId, row.id]);
  if (!other.rowCount) memberError(409, "LAST_WORKSPACE_ADMIN", "Workspace must retain an admin");
}
