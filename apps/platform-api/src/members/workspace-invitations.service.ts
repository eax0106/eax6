import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { z } from "zod";
import { computeEtag, ConcurrencyHttpError, ifMatchIncludes } from "../concurrency";
import type { IdentityInvitation, IdentityProvider } from "../identity/identity-provider.interface";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { FixedWorkspaceRole, lockManagedWorkspace, memberError, memberInstance, workspaceUuid } from "./workspace-authority";

const InvitationInput = z.object({ workspaceId: z.string(), email: z.string().trim().toLowerCase().email().max(320), role: FixedWorkspaceRole }).strict();
export interface InvitationView {
  id: string; workspaceId: string; email: string; role: string;
  status: "delivering" | "pending" | "delivery_failed" | "accepted" | "revoked" | "expired";
  expiresAt: string; createdAt: string; updatedAt: string; etag: string;
}
interface InvitationRow {
  id: string; workspace_id: string; email: string; role: string; status: InvitationView["status"];
  provider_org_ref: string; provider_invitation_id: string | null; delivery_attempt_id: string | null;
  expires_at: Date; created_at: Date; updated_at: Date;
}

export class WorkspaceInvitationsService {
  constructor(private readonly db: PlatformDb, private readonly provider: IdentityProvider, private readonly audit: AuditEventHandler) {}

  async list(actor: ActorContext, workspaceId: string): Promise<InvitationView[]> {
    const workspace = workspaceUuid(workspaceId);
    return this.db.withTenant(actor.tenant_id, async client => {
      await lockManagedWorkspace(client, actor, workspace);
      const rows = await client.query<InvitationRow>("SELECT * FROM workspace_invitations WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id", [actor.tenant_id, workspace]);
      return rows.rows.map(invitationView);
    });
  }

  async create(actor: ActorContext, body: unknown): Promise<InvitationView> {
    const parsed = InvitationInput.safeParse(body);
    if (!parsed.success) memberError(400, "INVALID_MEMBER_INVITE", "Workspace, valid email and fixed workspace role required");
    const input = parsed.data, workspace = workspaceUuid(input.workspaceId), id = uuidv7(), attempt = uuidv7();
    const claim = await this.db.withTenant(actor.tenant_id, async client => {
      const org = await lockManagedWorkspace(client, actor, workspace);
      if (!org) memberError(409, "ORGANIZATION_UNAVAILABLE", "Workspace identity organization is unavailable");
      await client.query("UPDATE workspace_invitations SET status='expired' WHERE tenant_id=$1 AND workspace_id=$2 AND email=$3 AND status='pending' AND expires_at<=now()", [actor.tenant_id, workspace, input.email]);
      const conflict = await client.query("SELECT 1 FROM workspace_invitations WHERE tenant_id=$1 AND workspace_id=$2 AND email=$3 AND status IN ('pending','delivering')", [actor.tenant_id, workspace, input.email]);
      if (conflict.rowCount) memberError(409, "INVITATION_EXISTS", "Invitation already pending; resend its existing record");
      const existing = await client.query("SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND lower(u.email)=$3", [actor.tenant_id, workspace, input.email]);
      if (existing.rowCount) memberError(409, "MEMBER_EXISTS", "This email already belongs to a workspace member");
      const result = await client.query<InvitationRow>(`INSERT INTO workspace_invitations(id,tenant_id,workspace_id,email,role,status,invited_by,provider_org_ref,delivery_attempt_id)
        VALUES($1,$2,$3,$4,$5,'delivering',$6,$7,$8) RETURNING *`, [id, actor.tenant_id, workspace, input.email, input.role, actor.user_id, org, attempt]);
      await this.record(actor, id, "workspace.invitation.delivery_started", "delivering", input.role);
      return result.rows[0]!;
    });
    return this.deliver(actor, claim);
  }

  async resend(actor: ActorContext, invitationId: string, ifMatch: string | undefined): Promise<InvitationView> {
    const claim = await this.db.withTenant(actor.tenant_id, async client => {
      const hint = await this.find(client, actor.tenant_id, invitationId);
      await lockManagedWorkspace(client, actor, hint.workspace_id);
      const row = await this.find(client, actor.tenant_id, invitationId, true);
      match(row, ifMatch);
      if (["accepted", "revoked"].includes(row.status)) memberError(409, "INVITATION_CLOSED", "Accepted or revoked invitation cannot be resent");
      if (row.status === "delivering" && row.updated_at.getTime() > Date.now() - 60000) memberError(409, "INVITATION_DELIVERING", "Invitation delivery is already in progress");
      const result = await client.query<InvitationRow>("UPDATE workspace_invitations SET status='delivering',delivery_attempt_id=$3,expires_at=now()+interval '7 days' WHERE tenant_id=$1 AND id=$2 RETURNING *", [actor.tenant_id, row.id, uuidv7()]);
      await this.record(actor, row.id, "workspace.invitation.delivery_started", "delivering", row.role);
      return result.rows[0]!;
    });
    return this.deliver(actor, claim);
  }

  async revoke(actor: ActorContext, invitationId: string, ifMatch: string | undefined): Promise<InvitationView> {
    const row = await this.db.withTenant(actor.tenant_id, async client => {
      const hint = await this.find(client, actor.tenant_id, invitationId);
      await lockManagedWorkspace(client, actor, hint.workspace_id);
      const current = await this.find(client, actor.tenant_id, invitationId, true);
      match(current, ifMatch);
      if (current.status === "accepted") memberError(409, "INVITATION_ACCEPTED", "Remove the accepted membership instead");
      const result = await client.query<InvitationRow>("UPDATE workspace_invitations SET status='revoked',delivery_attempt_id=NULL WHERE tenant_id=$1 AND id=$2 RETURNING *", [actor.tenant_id, current.id]);
      await this.record(actor, current.id, "workspace.invitation.revoked", "revoked", current.role);
      return result.rows[0]!;
    });
    // Local revocation commits first; provider outages cannot restore acceptance.
    if (row.provider_invitation_id) await this.provider.revokeOrganizationInvitation(row.provider_org_ref, row.provider_invitation_id).catch(() => undefined);
    return invitationView(row);
  }

  private async deliver(actor: ActorContext, claim: InvitationRow): Promise<InvitationView> {
    let created: IdentityInvitation | undefined, ticketHash: string | undefined;
    try {
      if (claim.provider_invitation_id) await this.provider.revokeOrganizationInvitation(claim.provider_org_ref, claim.provider_invitation_id);
      created = await this.provider.createOrganizationInvitation({ organizationId: claim.provider_org_ref, email: claim.email, inviterName: "Workspace administrator" });
      const url = new URL(created.invitationUrl), ticket = url.searchParams.get("invitation");
      const expiry = Date.parse(created.expiresAt);
      if (created.organizationId !== claim.provider_org_ref || !created.id || url.protocol !== "https:" || url.username || url.password || url.searchParams.get("organization") !== claim.provider_org_ref || !ticket || ticket.length > 4096 || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 604860000) throw new Error("Invalid provider invitation result");
      ticketHash = createHash("sha256").update(ticket).digest("hex");
    } catch {
      if (created) await this.provider.revokeOrganizationInvitation(claim.provider_org_ref, created.id).catch(() => undefined);
      await this.finish(actor, claim, undefined, undefined);
      memberError(503, "INVITATION_DELIVERY_FAILED", "Invitation was not sent; retry its existing record");
    }
    try {
      const row = await this.finish(actor, claim, created, ticketHash);
      if (row.status !== "pending" || row.delivery_attempt_id !== claim.delivery_attempt_id) {
        await this.provider.revokeOrganizationInvitation(claim.provider_org_ref, created.id).catch(() => undefined);
        memberError(409, "INVITATION_CHANGED", "Invitation changed during delivery");
      }
      return invitationView(row);
    } catch (error) {
      await this.provider.revokeOrganizationInvitation(claim.provider_org_ref, created.id).catch(() => undefined);
      throw error;
    }
  }

  private async finish(actor: ActorContext, claim: InvitationRow, created: IdentityInvitation | undefined, ticketHash: string | undefined): Promise<InvitationRow> {
    return this.db.withTenant(actor.tenant_id, async client => {
      await lockManagedWorkspace(client, actor, claim.workspace_id);
      const current = await this.find(client, actor.tenant_id, claim.id, true);
      if (current.status !== "delivering" || current.delivery_attempt_id !== claim.delivery_attempt_id) return current;
      const result = await client.query<InvitationRow>(`UPDATE workspace_invitations SET status=$3,provider_invitation_id=$4,provider_ticket_hash=$5,
        expires_at=COALESCE($6::timestamptz,expires_at) WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenant_id, claim.id, created ? "pending" : "delivery_failed", created?.id ?? null, ticketHash ?? null, created?.expiresAt ?? null]);
      await this.record(actor, claim.id, created ? "workspace.invitation.sent" : "workspace.invitation.delivery_failed", created ? "pending" : "delivery_failed", claim.role);
      return result.rows[0]!;
    });
  }

  private async find(client: import("pg").PoolClient, tenantId: string, id: string, lock = false): Promise<InvitationRow> {
    if (!z.string().uuid().safeParse(id).success) memberError(404, "INVITATION_NOT_FOUND", "Invitation not found");
    const result = await client.query<InvitationRow>("SELECT * FROM workspace_invitations WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""), [tenantId, id]);
    return result.rows[0] ?? memberError(404, "INVITATION_NOT_FOUND", "Invitation not found");
  }

  private record(actor: ActorContext, id: string, action: string, status: string, role: string): Promise<unknown> {
    return this.audit.recordEvent({ tenant_id: actor.tenant_id, actor_type: "user", actor_ref: actor.user_id, action, target_type: "workspace_invitation", target_ref: id,
      result: "success", reason_code: "", context_json: JSON.stringify({ status, role }), occurred_at: new Date().toISOString() });
  }
}

function etag(row: InvitationRow): string { return computeEtag({ id: row.id, role: row.role, status: row.status, updatedAt: row.updated_at.toISOString(), attempt: row.delivery_attempt_id }); }
function match(row: InvitationRow, value: string | undefined): void {
  if (!value) throw new ConcurrencyHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", memberInstance);
  if (!ifMatchIncludes(value, etag(row))) throw new ConcurrencyHttpError(412, "ETAG_MISMATCH", "Invitation changed since it was read", memberInstance);
}
function invitationView(row: InvitationRow): InvitationView {
  return { id: row.id, workspaceId: row.workspace_id, email: row.email, role: row.role, status: row.status === "pending" && row.expires_at.getTime() <= Date.now() ? "expired" : row.status,
    expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), etag: etag(row) };
}
