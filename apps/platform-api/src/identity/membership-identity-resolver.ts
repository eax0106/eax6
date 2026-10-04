import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { tenantRoles, workspaceRoles } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import type { ExistingSignup } from "../signup/types";
import type { AuthenticatedIdentity } from "./identity-provider.interface";
import { IdentityHttpError } from "./problem";

export class MembershipIdentityResolver {
  constructor(private readonly db: PlatformDb | undefined, private readonly audit: AuditEventHandler) {}

  async resolve(identity: AuthenticatedIdentity, invitation?: string): Promise<ExistingSignup | null> {
    if (!identity.emailVerified) reject("EMAIL_VERIFICATION_REQUIRED", "Verify your email before signing in");
    if (!this.db) throw new IdentityHttpError(503, "IDENTITY_STORAGE_UNAVAILABLE", "Identity storage is unavailable");
    if (invitation !== undefined) {
      if (!identity.organizationId || !invitation || invitation.length > 4096) reject("INVITATION_REJECTED", "Invitation context is unavailable");
      return this.accept(identity, invitation);
    }
    const existing = identity.organizationId
      ? await this.db.resolveOrganizationMember(identity.identityRef, identity.organizationId)
      : await this.db.findExisting(identity.identityRef, identity.tenantId);
    if (identity.organizationId && !existing) reject("ORGANIZATION_MEMBERSHIP_REQUIRED", "Use your current invitation link to join this organization");
    return existing ? validMembership(existing) : null;
  }

  private async accept(identity: AuthenticatedIdentity, ticket: string): Promise<ExistingSignup> {
    const db = this.db!;
    const hash = createHash("sha256").update(ticket).digest("hex"), email = identity.email.trim().toLowerCase();
    const scope = await db.resolveInvitation(identity.organizationId!, email, hash);
    if (!scope) reject("INVITATION_REJECTED", "Invitation does not match your verified identity");
    return db.withTenant(scope.tenantId, async client => {
      const workspace = await client.query(`SELECT w.id FROM workspaces w JOIN tenants t ON t.id=w.tenant_id
        WHERE w.tenant_id=$1 AND w.id=$2 AND w.status='active' AND t.status='active' AND t.identity_org_ref=$3 FOR UPDATE OF w`,
        [scope.tenantId, scope.workspaceId, identity.organizationId]);
      if (!workspace.rowCount) reject("INVITATION_REJECTED", "Invitation workspace is unavailable");
      const result = await client.query<{ id: string; role: string; status: string; expires_at: Date; accepted_by: string | null }>(
        `SELECT id,role,status,expires_at,accepted_by FROM workspace_invitations WHERE tenant_id=$1 AND id=$2 AND workspace_id=$3
           AND provider_org_ref=$4 AND email=$5 AND provider_ticket_hash=$6 FOR UPDATE`,
        [scope.tenantId, scope.invitationId, scope.workspaceId, identity.organizationId, email, hash]);
      const row = result.rows[0];
      if (!row) reject("INVITATION_REJECTED", "Invitation changed before acceptance");
      if (row.status !== "accepted" && (row.status !== "pending" || row.expires_at.getTime() <= Date.now())) reject("INVITATION_CLOSED", "Invitation expired or was revoked");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["identity:" + identity.identityRef]);
      const users = await client.query<{ id: string; status: string }>("SELECT id,status FROM users WHERE identity_ref=$1 ORDER BY id", [identity.identityRef]);
      if (users.rows.length > 1 || (users.rows[0] && users.rows[0].status !== "active")) reject("IDENTITY_REJECTED", "Identity account is unavailable");
      let userId = users.rows[0]?.id;
      if (row.status === "accepted") {
        if (!userId || row.accepted_by !== userId) reject("INVITATION_REJECTED", "Invitation was accepted by a different identity");
      } else {
        if (!userId) {
          userId = uuidv7();
          await client.query("INSERT INTO users(id,identity_ref,email,display_name,status) VALUES($1,$2,$3,$4,'active')", [userId, identity.identityRef, email, identity.displayName ?? null]);
        }
        await client.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT(tenant_id,user_id) DO NOTHING", [uuidv7(), scope.tenantId, userId]);
        await client.query("INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,user_id) DO NOTHING", [uuidv7(), scope.tenantId, scope.workspaceId, userId, row.role]);
        await client.query("UPDATE workspace_invitations SET status='accepted',accepted_by=$3,accepted_at=now(),delivery_attempt_id=NULL WHERE tenant_id=$1 AND id=$2", [scope.tenantId, row.id, userId]);
        await this.audit.recordEvent({ tenant_id: scope.tenantId, actor_type: "user", actor_ref: userId, action: "workspace.invitation.accepted", target_type: "workspace_invitation", target_ref: row.id,
          result: "success", reason_code: "", context_json: JSON.stringify({ workspaceId: scope.workspaceId, role: row.role }), occurred_at: new Date().toISOString() });
      }
      const memberships = await client.query<ExistingSignup>(`SELECT tm.user_id AS "userId",tm.tenant_id AS "tenantId",wm.workspace_id AS "workspaceId",tm.role AS "tenantRole",wm.role AS "workspaceRole"
        FROM tenant_members tm JOIN workspace_members wm ON wm.tenant_id=tm.tenant_id AND wm.user_id=tm.user_id
        WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND wm.workspace_id=$3`, [scope.tenantId, userId, scope.workspaceId]);
      return validMembership(memberships.rows[0] ?? reject("MEMBERSHIP_REVOKED", "Workspace membership is no longer available"));
    });
  }
}

function validMembership(value: ExistingSignup): ExistingSignup {
  if (!(tenantRoles as readonly string[]).includes(value.tenantRole) || !(workspaceRoles as readonly string[]).includes(value.workspaceRole)) reject("MEMBERSHIP_REJECTED", "Stored membership role is unavailable");
  return value;
}
function reject(code: string, detail: string): never { throw new IdentityHttpError(403, code, detail); }
