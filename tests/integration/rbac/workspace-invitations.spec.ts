import { Test } from "@nestjs/testing";
import { APP_GUARD, APP_FILTER, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ActorContextGuard } from "../../../apps/platform-api/src/rbac/actor-context.guard";
import { RbacGuard } from "../../../apps/platform-api/src/rbac/rbac.guard";
import { RbacExceptionFilter } from "../../../apps/platform-api/src/rbac/rbac-exception.filter";
import { WorkspaceResourceTenantResolver, PlatformDbWorkspaceTenantLookup } from "../../../apps/platform-api/src/rbac/resource-tenant.resolver";
import { ParamWorkspaceResolver } from "../../../apps/platform-api/src/rbac/param-workspace.resolver";
import { MembersController } from "../../../apps/platform-api/src/members/members.controller";
import { IdentityController } from "../../../apps/platform-api/src/identity/identity.controller";
import { UserProfileRepository } from "../../../apps/platform-api/src/identity/user-profile.repository";
import { SignupController } from "../../../apps/platform-api/src/signup/signup.controller";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { MockIdentityProvider } from "../../../apps/platform-api/src/identity/adapters/mock/mock-identity-provider";
import type { ActorContext } from "../../../apps/platform-api/src/rbac/types";
import { MembersService } from "../../../apps/platform-api/src/members/members.service";
import { StreamRevocationBus } from "../../../apps/platform-api/src/streaming/revocation";
import { WorkspaceInvitationsService } from "../../../apps/platform-api/src/members/workspace-invitations.service";
import { MembershipIdentityResolver } from "../../../apps/platform-api/src/identity/membership-identity-resolver";
import { IdentityService } from "../../../apps/platform-api/src/identity/identity.service";
import { PgSessionStore } from "../../../apps/platform-api/src/identity/session-store";
import { IdentityBrokerService } from "../../../apps/platform-api/src/identity-broker/identity-broker.service";
import { GeneratedSigningKeyResolver } from "../../../apps/platform-api/src/identity-broker/signing-key-resolver";
import { verifyActorToken, decodeActorToken } from "../../../apps/platform-api/src/identity-broker/jwt";
import { InternalEntitlementProvider } from "../../../apps/platform-api/src/entitlements/internal-entitlement-provider";
import { PostgresEntitlementStore } from "../../../apps/platform-api/src/entitlements/entitlement-store";
import { LocalFileConfigProvider } from "../../../apps/platform-api/src/entitlements/adapters/local-file/local-file-config-provider";
import { OnboardingRepository } from "../../../apps/platform-api/src/onboarding/onboarding.repository";
import { SignupService } from "../../../apps/platform-api/src/signup/signup.service";
import { ProcessLocalSignupIdempotencyStore } from "../../../apps/platform-api/src/signup/idempotency-store";
import { PlatformDb } from "../../../apps/platform-api/src/signup/platform-db";

const migration = "apps/platform-api/src/db/migrations/";
const tenant = uuidv7(), otherTenant = uuidv7(), workspace = uuidv7(), otherWorkspace = uuidv7(), actor = uuidv7();

describe.sequential("workspace invitation authority under ordinary PostgreSQL", () => {
  let container: StartedPostgreSqlContainer, admin: pg.Client, pool: pg.Pool, db: PlatformDb;
  async function apply(path: string) {
    for (const statement of readFileSync(resolve(migration, path), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(statement);
  }
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    admin = new pg.Client({ connectionString: container.getConnectionUri() }); await admin.connect();
    await admin.query("CREATE ROLE platform_api NOSUPERUSER NOBYPASSRLS");
    for (const file of ["0000_platform_db_identity_foundation.sql", "0001_identity_sessions_sso.sql", "0002_signup_existing_membership.sql", "0003_onboarding_states.sql", "0006_billing_profiles.sql", "0007_billing_webhooks.sql", "0033_workspace_invitations.sql"]) await apply(file);
    await admin.query("CREATE ROLE member_native LOGIN PASSWORD 'native-only' NOSUPERUSER NOBYPASSRLS");
    await admin.query("GRANT EXECUTE ON FUNCTION resolve_existing_signup(text,uuid),resolve_workspace_invitation(text,text,text),resolve_existing_organization_member(text,text) TO member_native");
    await admin.query("GRANT USAGE ON SCHEMA public TO member_native"); await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO member_native");
    await admin.query("INSERT INTO tenants(id,name,status,identity_org_ref) VALUES($1,'Invited tenant','active','org_native'),($2,'Other tenant','active','org_other')", [tenant, otherTenant]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'Invited workspace','active'),($3,$4,'Other workspace','active')", [workspace, tenant, otherWorkspace, otherTenant]);
    await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,'auth0|administrator','admin@company.test','active')", [actor]);
    await admin.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'owner')", [uuidv7(), tenant, actor]);
    await admin.query("INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,'admin')", [uuidv7(), tenant, workspace, actor]);
    const url = new URL(container.getConnectionUri()); url.username = "member_native"; url.password = "native-only";
    pool = new pg.Pool({ connectionString: url.href }); db = new PlatformDb(pool);
  }, 120000);
  afterAll(async () => { await pool?.end(); await admin?.end(); await container?.stop(); });
  const insert = (email: string, role = "viewer", scope = tenant, target = workspace) => db.queryTenant<{ id: string; expires_at: Date; created_at: Date }>(scope,
    "INSERT INTO workspace_invitations(id,tenant_id,workspace_id,email,role,status,invited_by,provider_org_ref,provider_invitation_id,provider_ticket_hash) VALUES($1,$2,$3,$4,$5,'pending',$6,'org_native',$7,$8) RETURNING id,expires_at,created_at",
    [uuidv7(), scope, target, email, role, actor, "uinv_" + uuidv7(), createHash("sha256").update(uuidv7()).digest("hex")]);

  it("keeps reads and mutations tenant-scoped and refuses a foreign workspace", async () => {
    const mine = (await insert("mine@company.test"))[0]!; const foreign = (await insert("other@company.test", "viewer", otherTenant, otherWorkspace))[0]!;
    expect((await pool.query("SELECT id FROM workspace_invitations")).rows).toEqual([]);
    expect(await db.queryTenant(tenant, "SELECT id FROM workspace_invitations")).toEqual([{ id: mine.id }]);
    expect(await db.queryTenant(tenant, "UPDATE workspace_invitations SET status='revoked' WHERE id=$1 RETURNING id", [foreign.id])).toEqual([]);
    expect(await db.queryTenant(tenant, "DELETE FROM workspace_invitations WHERE id=$1 RETURNING id", [foreign.id])).toEqual([]);
    await expect(insert("wrong-workspace@company.test", "viewer", tenant, otherWorkspace)).rejects.toMatchObject({ code: "23503" });
    const flags = (await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]; expect(flags).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it("stores seven-day expiry and only the five fixed workspace roles with normalized emails", async () => {
    for (const role of ["admin", "editor", "operator", "approver", "viewer"]) {
      const row = (await insert(role + "@company.test", role))[0]!; expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(604800000);
    }
    for (const role of ["owner", "member", "custom"]) await expect(insert(role + "@company.test", role)).rejects.toMatchObject({ code: "23514" });
    for (const email of ["Upper@company.test", " padded@company.test "]) await expect(insert(email)).rejects.toMatchObject({ code: "23514" });
  });
  it("has one pending invite per workspace/email under concurrent creation and preserves revoked history", async () => {
    const results = await Promise.allSettled([insert("race@company.test"), insert("race@company.test")]);
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1); expect(results.filter(value => value.status === "rejected")).toHaveLength(1);
    await db.queryTenant(tenant, "UPDATE workspace_invitations SET status='revoked' WHERE email='race@company.test'");
    await insert("race@company.test");
    expect((await db.queryTenant(tenant, "SELECT status FROM workspace_invitations WHERE email='race@company.test' ORDER BY created_at,status")).map(row => row.status).sort()).toEqual(["pending", "revoked"]);
    await expect(db.queryTenant(tenant, "UPDATE workspace_invitations SET tenant_id=$1 WHERE email='race@company.test'", [otherTenant])).rejects.toThrow("tenant_id is immutable");
  });
  const caller: ActorContext = { tenant_id: tenant, user_id: actor, roles: ["owner"], permissions: [], session_id: "native-session" };
  function fixture() {
    const provider = new MockIdentityProvider(), recordEvent = vi.fn().mockResolvedValue({});
    const service = new WorkspaceInvitationsService(db, provider, { recordEvent, getEvent: vi.fn() } as unknown as AuditEventHandler);
    return { provider, recordEvent, service };
  }
  it("delivers only one concurrent invitation and exposes no provider ticket", async () => {
    const { service, provider, recordEvent } = fixture();
    const create = vi.spyOn(provider, "createOrganizationInvitation");
    const outcomes = await Promise.allSettled([service.create(caller, { workspaceId: workspace, email: "SERVICE@company.test", role: "viewer" }), service.create(caller, { workspaceId: workspace, email: "service@company.test", role: "viewer" })]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1); expect(create).toHaveBeenCalledOnce();
    const view = (await service.list(caller, workspace)).find(row => row.email === "service@company.test")!;
    expect(view).toMatchObject({ status: "pending", role: "viewer", email: "service@company.test" });
    const remote = await create.mock.results[0]!.value;
    const ticket = new URL(remote.invitationUrl).searchParams.get("invitation")!;
    expect(JSON.stringify(view)).not.toContain(ticket);
    const stored = await db.queryTenant(tenant, "SELECT provider_ticket_hash FROM workspace_invitations WHERE id=$1", [view.id]);
    expect(stored[0]?.provider_ticket_hash).toBe(createHash("sha256").update(ticket).digest("hex"));
    expect(recordEvent.mock.calls.map(call => call[0].action)).toEqual(["workspace.invitation.delivery_started", "workspace.invitation.sent"]);
    expect(recordEvent.mock.calls[1]?.[0]).toMatchObject({ tenant_id: tenant, actor_ref: actor, target_ref: view.id });
  });
  it("uses database workspace authority and validates email, role and scope before delivery", async () => {
    const { service, provider } = fixture(), create = vi.spyOn(provider, "createOrganizationInvitation");
    const viewer = uuidv7();
    await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,$2,'viewer@company.test','active')", [viewer, "mock|" + viewer]);
    await db.queryTenant(tenant, "INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'member')", [uuidv7(), tenant, viewer]);
    await db.queryTenant(tenant, "INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,'viewer')", [uuidv7(), tenant, workspace, viewer]);
    await expect(service.create({ ...caller, user_id: viewer, roles: ["owner","admin"] }, { workspaceId: workspace, email: "refused@company.test", role: "editor" })).rejects.toMatchObject({ status: 403 });
    await expect(service.create(caller, { workspaceId: otherWorkspace, email: "foreign@company.test", role: "viewer" })).rejects.toMatchObject({ status: 404 });
    for (const body of [{ workspaceId: workspace, email: "bad", role: "viewer" }, { workspaceId: workspace, email: "valid@company.test", role: "owner" }, { workspaceId: workspace, email: "valid@company.test", role: "viewer", userId: uuidv7() }]) await expect(service.create(caller, body)).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps failed delivery truthful, requires current If-Match and resends a fresh provider ticket", async () => {
    const { service, provider } = fixture();
    vi.spyOn(provider, "createOrganizationInvitation").mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(service.create(caller, { workspaceId: workspace, email: "retry@company.test", role: "operator" })).rejects.toMatchObject({ status: 503 });
    let row = (await service.list(caller, workspace)).find(row => row.email === "retry@company.test")!;
    expect(row.status).toBe("delivery_failed");
    await expect(service.resend(caller, row.id, undefined)).rejects.toMatchObject({ status: 428 });
    await expect(service.resend(caller, row.id, '"stale"')).rejects.toMatchObject({ status: 412 });
    row = await service.resend(caller, row.id, row.etag); expect(row.status).toBe("pending");
    const before = (await db.queryTenant(tenant, "SELECT provider_invitation_id,provider_ticket_hash FROM workspace_invitations WHERE id=$1", [row.id]))[0]!;
    const next = await service.resend(caller, row.id, row.etag); expect(next.status).toBe("pending");
    const after = (await db.queryTenant(tenant, "SELECT provider_invitation_id,provider_ticket_hash FROM workspace_invitations WHERE id=$1", [row.id]))[0]!;
    expect(after.provider_invitation_id).not.toBe(before.provider_invitation_id); expect(after.provider_ticket_hash).not.toBe(before.provider_ticket_hash);
    const revoked = await service.revoke(caller, next.id, next.etag); expect(revoked.status).toBe("revoked");
    await expect(service.resend(caller, revoked.id, revoked.etag)).rejects.toMatchObject({ status: 409 });
  });
  it("fences a delivery revoked while the provider is in flight", async () => {
    const { service, provider } = fixture(), original = provider.createOrganizationInvitation.bind(provider);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const create = vi.spyOn(provider, "createOrganizationInvitation").mockImplementation(async input => { started(); await hold; return original(input); });
    const cancel = vi.spyOn(provider, "revokeOrganizationInvitation");
    const pending = service.create(caller, { workspaceId: workspace, email: "inflight@company.test", role: "approver" });
    await waiting;
    const row = (await service.list(caller, workspace)).find(row => row.email === "inflight@company.test")!;
    expect(row.status).toBe("delivering");
    await expect(service.resend(caller, row.id, row.etag)).rejects.toMatchObject({ status: 409 });
    await service.revoke(caller, row.id, row.etag); release();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect((await service.list(caller, workspace)).find(value => value.id === row.id)?.status).toBe("revoked");
    const remote = await create.mock.results[0]!.value; expect(cancel).toHaveBeenCalledWith("org_native", remote.id);
  });
  it("fences late completion after a stale delivery is retried and cancels its obsolete provider ticket", async () => {
    const { service, provider } = fixture(), original = provider.createOrganizationInvitation.bind(provider);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const create = vi.spyOn(provider, "createOrganizationInvitation").mockImplementationOnce(async input => { started(); await hold; return original(input); });
    const cancel = vi.spyOn(provider, "revokeOrganizationInvitation");
    const pending = service.create(caller, { workspaceId: workspace, email: "stale-inflight@company.test", role: "operator" });
    await waiting;
    const row = (await service.list(caller, workspace)).find(row => row.email === "stale-inflight@company.test")!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    try {
      const current = await service.resend(caller, row.id, row.etag); expect(current.status).toBe("pending");
      const currentRemote = await create.mock.results[1]!.value;
      const rejected = expect(pending).rejects.toMatchObject({ status: 409 }); release(); await rejected;
      const obsoleteRemote = await create.mock.results[0]!.value;
      expect(cancel).toHaveBeenCalledWith("org_native", obsoleteRemote.id);
      const stored = (await db.queryTenant(tenant, "SELECT status,provider_invitation_id,provider_ticket_hash FROM workspace_invitations WHERE id=$1", [row.id]))[0]!;
      expect(stored).toMatchObject({ status: "pending", provider_invitation_id: currentRemote.id,
        provider_ticket_hash: createHash("sha256").update(new URL(currentRemote.invitationUrl).searchParams.get("invitation")!).digest("hex") });
    } finally { release(); clock.mockRestore(); }
  });
  it("rolls back an unaudited claim and never marks failed finalization as sent", async () => {
    const { service, provider, recordEvent } = fixture(); const create = vi.spyOn(provider, "createOrganizationInvitation"), cancel = vi.spyOn(provider, "revokeOrganizationInvitation");
    recordEvent.mockRejectedValueOnce(new Error("audit offline"));
    await expect(service.create(caller, { workspaceId: workspace, email: "audit-claim@company.test", role: "viewer" })).rejects.toThrow("audit offline");
    expect(create).not.toHaveBeenCalled();
    expect(await db.queryTenant(tenant, "SELECT id FROM workspace_invitations WHERE email='audit-claim@company.test'")).toEqual([]);
    recordEvent.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("final audit offline"));
    await expect(service.create(caller, { workspaceId: workspace, email: "audit-finish@company.test", role: "viewer" })).rejects.toThrow("final audit offline");
    expect((await service.list(caller, workspace)).find(row => row.email === "audit-finish@company.test")?.status).toBe("delivering");
    const remote = await create.mock.results[0]!.value; expect(cancel).toHaveBeenCalledWith("org_native", remote.id);
  });
  function membersFixture() {
    const { provider, recordEvent, service: invitations } = fixture();
    const revocations = new StreamRevocationBus(), publish = vi.spyOn(revocations, "publish");
    const members = new MembersService(db, revocations, { recordEvent, getEvent: vi.fn() } as unknown as AuditEventHandler, invitations);
    return { members, provider, recordEvent, publish };
  }
  async function addMember(target: string, role: string) {
    const user = uuidv7(), id = uuidv7();
    await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,$2,$3,'active')", [user, "mock|" + user, user + "@company.test"]);
    await db.queryTenant(tenant, "INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'member')", [uuidv7(), tenant, user]);
    await db.queryTenant(tenant, "INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,$5)", [id, tenant, target, user, role]);
    return { user, id };
  }
  it("lists actual workspace members, exposes tenant owner badge, and protects owner and current edit version", async () => {
    const { members, publish } = membersFixture();
    const rows = await members.list(caller, workspace), owner = rows.find(row => row.userId === actor)!;
    expect(owner).toMatchObject({ tenantOwner: true, role: "admin", scope: "workspace", workspaceId: workspace });
    await addMember(workspace, "admin");
    await expect(members.updateRole(caller, owner.id, { role: "viewer" }, owner.etag)).rejects.toMatchObject({ status: 409, response: { error_code: "TENANT_OWNER_IMMUTABLE" } });
    await expect(members.remove(caller, owner.id, "workspace", owner.etag)).rejects.toMatchObject({ status: 409, response: { error_code: "TENANT_OWNER_IMMUTABLE" } });
    await expect(members.remove(caller, owner.id, "tenant", owner.etag)).rejects.toMatchObject({ status: 400 });
    const added = await addMember(workspace, "viewer"), current = (await members.list(caller, workspace)).find(row => row.id === added.id)!;
    await expect(members.updateRole(caller, current.id, { role: "member" }, current.etag)).rejects.toMatchObject({ status: 400 });
    await expect(members.updateRole(caller, current.id, { role: "editor" }, undefined)).rejects.toMatchObject({ status: 428 });
    await expect(members.updateRole(caller, current.id, { role: "editor" }, '"stale"')).rejects.toMatchObject({ status: 412 });
    expect(publish).not.toHaveBeenCalled();
    for (const role of ["admin", "editor", "operator", "approver", "viewer"]) {
      const before = (await members.list(caller, workspace)).find(row => row.id === added.id)!;
      expect((await members.updateRole(caller, before.id, { role }, before.etag)).role).toBe(role);
    }
    expect(publish).toHaveBeenCalledTimes(5);
  });
  it("refuses a flat admin claim from a different workspace and returns only accessible workspace members", async () => {
    const { members } = membersFixture(), target = uuidv7(), added = await addMember(workspace, "viewer");
    await db.queryTenant(tenant, "INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'Other same-tenant workspace','active')", [target, tenant]);
    await db.queryTenant(tenant, "INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,'admin')", [uuidv7(), tenant, target, added.user]);
    const impostor = { ...caller, user_id: added.user, roles: ["owner", "admin"], workspace_id: target };
    const view = (await members.list(caller, workspace)).find(row => row.id === added.id)!;
    await expect(members.updateRole(impostor, view.id, { role: "editor" }, view.etag)).rejects.toMatchObject({ status: 403 });
    await expect(members.remove(impostor, view.id, "workspace", view.etag)).rejects.toMatchObject({ status: 403 });
    expect((await members.list(impostor, target)).map(row => row.userId)).toEqual([added.user]);
    await expect(members.list(impostor, otherWorkspace)).rejects.toMatchObject({ status: 403 });
  });
  it("serializes concurrent demotions and removals so one workspace admin always survives", async () => {
    const { members } = membersFixture(), target = uuidv7();
    await db.queryTenant(tenant, "INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'Concurrent admins','active')", [target, tenant]);
    const a = await addMember(target, "admin"), b = await addMember(target, "admin");
    const before = await members.list(caller, target);
    const outcomes = await Promise.allSettled(before.map(row => members.updateRole(caller, row.id, { role: "editor" }, row.etag)));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const remaining = (await members.list(caller, target)).find(row => row.role === "admin")!;
    await expect(members.remove(caller, remaining.id, "workspace", remaining.etag)).rejects.toMatchObject({ status: 409, response: { error_code: "LAST_WORKSPACE_ADMIN" } });
    const removed = (await members.list(caller, target)).find(row => row.role === "editor")!;
    await members.remove(caller, removed.id, "workspace", removed.etag);
    expect((await members.list(caller, target)).map(row => row.id)).toEqual([remaining.id]);
    expect([a.id, b.id]).toContain(remaining.id);
  });
  it("rolls back role/delete writes on audit failure and revokes access only after committed mutations", async () => {
    const { members, recordEvent, publish } = membersFixture(), added = await addMember(workspace, "editor");
    let view = (await members.list(caller, workspace)).find(row => row.id === added.id)!;
    recordEvent.mockRejectedValueOnce(new Error("role audit offline"));
    await expect(members.updateRole(caller, view.id, { role: "operator" }, view.etag)).rejects.toThrow("role audit offline");
    expect((await members.list(caller, workspace)).find(row => row.id === added.id)?.role).toBe("editor"); expect(publish).not.toHaveBeenCalled();
    view = await members.updateRole(caller, view.id, { role: "operator" }, view.etag);
    expect(publish).toHaveBeenCalledWith({ tenantId: tenant, userId: added.user }); publish.mockClear();
    recordEvent.mockRejectedValueOnce(new Error("delete audit offline"));
    await expect(members.remove(caller, view.id, "workspace", view.etag)).rejects.toThrow("delete audit offline");
    expect((await members.list(caller, workspace)).find(row => row.id === added.id)).toBeDefined(); expect(publish).not.toHaveBeenCalled();
    await members.remove(caller, view.id, "workspace", view.etag);
    expect((await members.list(caller, workspace)).find(row => row.id === added.id)).toBeUndefined(); expect(publish).toHaveBeenCalledOnce();
    expect(recordEvent.mock.calls.at(-1)?.[0]).toMatchObject({ action: "workspace.member.removed", target_ref: added.id, actor_ref: actor });
  });
  async function callbackFixture(email: string, role = "viewer") {
    const { provider, service, recordEvent } = fixture();
    const created = vi.spyOn(provider, "createOrganizationInvitation");
    const invitation = await service.create(caller, { workspaceId: workspace, email, role });
    const remote = await created.mock.results[0]!.value, ticket = new URL(remote.invitationUrl).searchParams.get("invitation")!;
    const resolver = new MembershipIdentityResolver(db, { recordEvent, getEvent: vi.fn() } as unknown as AuditEventHandler);
    const sessions = new PgSessionStore(pool), identity = new IdentityService(provider, sessions, undefined, resolver);
    const request = { code: "invite:" + ticket, redirectUri: "https://app.example.com/auth/callback", codeVerifier: "native-pkce-verifier", invitation: ticket };
    const verified = await provider.handleCallback(request);
    return { provider, invitations: service, invitation, ticket, resolver, identity, sessions, request, verified, recordEvent };
  }
  it("accepts verified provider callback once, stores ordinary membership and issues internal tenant sessions", async () => {
    const { identity, request, invitation } = await callbackFixture("accepted@company.test", "operator");
    const outcomes = await Promise.all([identity.handleCallback(request), identity.handleCallback(request)]);
    expect(outcomes[0]?.userId).toBe(outcomes[1]?.userId); expect(outcomes[0]?.tenantId).toBe(tenant);
    expect(await identity.authenticateAccessToken(outcomes[0]!.accessToken)).toMatchObject({ userId: outcomes[0]!.userId, tenantId: tenant, id: outcomes[0]!.sessionId });
    const rows = await db.queryTenant(tenant, "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspace, outcomes[0]!.userId]); expect(rows).toEqual([{ role: "operator" }]);
    const accepted = await db.queryTenant(tenant, "SELECT status,accepted_by FROM workspace_invitations WHERE id=$1", [invitation.id]);
    expect(accepted).toEqual([{ status: "accepted", accepted_by: outcomes[0]!.userId }]);
    expect(await db.queryTenant(tenant, "SELECT role FROM tenant_members WHERE user_id=$1", [outcomes[0]!.userId])).toEqual([{ role: "member" }]);
  });
  it("rejects unverified, mismatched, foreign, revoked and expired callbacks before issuing sessions", async () => {
    const { resolver, identity, provider, request, verified, invitations, invitation, ticket } = await callbackFixture("denied@company.test");
    for (const profile of [{ ...verified, emailVerified: false }, { ...verified, email: "wrong@company.test" }, { ...verified, organizationId: "org_other" }, { ...verified, organizationId: "" }]) await expect(resolver.resolve(profile, ticket)).rejects.toMatchObject({ status: 403 });
    const issue = vi.spyOn(identity, "issueSignupSession");
    const providerCallback = vi.spyOn(provider, "handleCallback").mockResolvedValueOnce({ ...verified, emailVerified: false });
    await expect(identity.handleCallback(request)).rejects.toMatchObject({ status: 403 }); expect(issue).not.toHaveBeenCalled(); providerCallback.mockRestore();
    await db.queryTenant(tenant, "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [invitation.id]);
    await expect(identity.handleCallback(request)).rejects.toMatchObject({ status: 403 });
    const row = (await invitations.list(caller, workspace)).find(row => row.id === invitation.id)!;
    await invitations.revoke(caller, row.id, row.etag);
    await expect(resolver.resolve(verified, ticket)).rejects.toMatchObject({ status: 403 });
    expect(await db.queryTenant(tenant, "SELECT id FROM users WHERE identity_ref=$1", [verified.identityRef])).toEqual([]);
  });
  it("reads current accepted role and refuses removed membership on invitation replay", async () => {
    const f = await callbackFixture("replay@company.test", "viewer"), accepted = await f.resolver.resolve(f.verified, f.ticket);
    const { members } = membersFixture();
    let current = (await members.list(caller, workspace)).find(row => row.userId === accepted!.userId)!;
    current = await members.updateRole(caller, current.id, { role: "approver" }, current.etag);
    expect(await f.resolver.resolve(f.verified, f.ticket)).toMatchObject({ workspaceRole: "approver" });
    await members.remove(caller, current.id, "workspace", current.etag);
    await expect(f.resolver.resolve(f.verified, f.ticket)).rejects.toMatchObject({ status: 403 });
    expect(await db.queryTenant(tenant, "SELECT id FROM workspace_members WHERE user_id=$1 AND workspace_id=$2", [accepted!.userId, workspace])).toEqual([]);
  });
  it("reuses verified provider identity across tenants without merging accounts by email", async () => {
    const f = await callbackFixture("existing@company.test", "editor"), user = uuidv7(), emailTwin = uuidv7();
    await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,$2,'old@company.test','active'),($3,'auth0|different-email-account','existing@company.test','active')", [user, f.verified.identityRef, emailTwin]);
    await db.queryTenant(otherTenant, "INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'member')", [uuidv7(), otherTenant, user]);
    await db.queryTenant(otherTenant, "INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,'viewer')", [uuidv7(), otherTenant, otherWorkspace, user]);
    expect(await f.resolver.resolve(f.verified, f.ticket)).toMatchObject({ userId: user, tenantId: tenant, workspaceRole: "editor" });
    expect(await db.queryTenant(tenant, "SELECT id FROM workspace_members WHERE user_id=$1", [emailTwin])).toEqual([]);
    expect(await db.queryTenant(otherTenant, "SELECT role FROM workspace_members WHERE user_id=$1", [user])).toEqual([{ role: "viewer" }]);
  });
  it("rolls back acceptance, new identity and memberships when audit fails", async () => {
    const f = await callbackFixture("accept-audit@company.test"); f.recordEvent.mockRejectedValueOnce(new Error("accept audit offline"));
    await expect(f.identity.handleCallback(f.request)).rejects.toThrow("accept audit offline");
    expect(await db.queryTenant(tenant, "SELECT id FROM users WHERE identity_ref=$1", [f.verified.identityRef])).toEqual([]);
    expect(await db.queryTenant(tenant, "SELECT status,accepted_by FROM workspace_invitations WHERE id=$1", [f.invitation.id])).toEqual([{ status: "pending", accepted_by: null }]);
  });
  it("refuses retired resend ticket, resolves existing organization membership and rejects outsiders", async () => {
    const f = await callbackFixture("replacement@company.test", "editor"), create = vi.spyOn(f.provider, "createOrganizationInvitation");
    const fresh = await f.invitations.resend(caller, f.invitation.id, f.invitation.etag), remote = await create.mock.results.at(-1)!.value;
    const ticket = new URL(remote.invitationUrl).searchParams.get("invitation")!;
    await expect(f.resolver.resolve(f.verified, f.ticket)).rejects.toMatchObject({ status: 403 });
    const accepted = await f.resolver.resolve(f.verified, ticket); expect(accepted).toMatchObject({ workspaceRole: "editor" });
    expect(await f.resolver.resolve(f.verified)).toEqual(accepted);
    await expect(f.resolver.resolve({ ...f.verified, identityRef: "auth0|outsider" })).rejects.toMatchObject({ status: 403 });
    expect(fresh.id).toBe(f.invitation.id);
  });
  it("bootstrap lookup returns only exact verified ticket context through narrowly granted functions", async () => {
    const f = await callbackFixture("lookup@company.test"), hash = createHash("sha256").update(f.ticket).digest("hex");
    expect(await db.resolveInvitation("org_native", f.verified.email, hash)).toEqual({ invitationId: f.invitation.id, tenantId: tenant, workspaceId: workspace });
    expect(await db.resolveInvitation("org_other", f.verified.email, hash)).toBeNull(); expect(await db.resolveInvitation("org_native", "wrong@company.test", hash)).toBeNull(); expect(await db.resolveInvitation("org_native", f.verified.email, "")).toBeNull();
    expect((await pool.query("SELECT id FROM workspace_invitations WHERE id=$1", [f.invitation.id])).rows).toEqual([]);
    const publicGrant = await admin.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE p.oid='resolve_workspace_invitation(text,text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed");
    expect(publicGrant.rows[0].allowed).toBe(false);
  });
  it("signup landing carries accepted internal ids, real session and signed current role without provisioning a new tenant", async () => {
    const f = await callbackFixture("signup-callback@company.test", "approver"), keys = new GeneratedSigningKeyResolver();
    const onboarding = new OnboardingRepository(pool), initialize = vi.spyOn(onboarding, "initialize"), org = vi.spyOn(f.provider, "getOrCreateOrgForTenant");
    const signup = new SignupService(f.provider, f.identity, new IdentityBrokerService("native/invite", keys), new InternalEntitlementProvider(new PostgresEntitlementStore(pool), new LocalFileConfigProvider()), db,
      new ProcessLocalSignupIdempotencyStore(), onboarding, f.resolver);
    const landing = await signup.signup({ ...f.request, idempotencyKey: uuidv7() });
    expect(landing).toMatchObject({ tenantId: tenant, workspaceId: workspace, tenantRole: "member", workspaceRole: "approver", returning: true });
    expect(landing.userId).not.toContain("mock|"); expect(initialize).not.toHaveBeenCalled(); expect(org).not.toHaveBeenCalled();
    expect(verifyActorToken(landing.actorToken.token, await keys.resolvePublicKey("native/invite"))).toBe(true);
    const claims = decodeActorToken(landing.actorToken.token);
    expect(claims).toMatchObject({ user_id: "usr_" + landing.userId, tenant_id: "ten_" + tenant, workspace_id: "ws_" + workspace, roles: ["member","approver"] });
    expect(await f.identity.authenticateAccessToken(landing.session.accessToken)).toMatchObject({ userId: landing.userId, tenantId: tenant, id: landing.session.sessionId });
  });
  it("serves real callback, invitation, role and reset HTTP through production session/RBAC guards", async () => {
    const f = await callbackFixture("http-callback@company.test", "viewer"), keys = new GeneratedSigningKeyResolver();
    const signup = new SignupService(f.provider, f.identity, new IdentityBrokerService("native/http", keys), new InternalEntitlementProvider(new PostgresEntitlementStore(pool), new LocalFileConfigProvider()), db,
      new ProcessLocalSignupIdempotencyStore(), new OnboardingRepository(pool), f.resolver);
    const members = new MembersService(db, undefined, { recordEvent: f.recordEvent, getEvent: vi.fn() } as unknown as AuditEventHandler, f.invitations);
    const module = await Test.createTestingModule({ controllers: [MembersController, IdentityController, SignupController], providers: [
      { provide: MembersService, useValue: members }, { provide: WorkspaceInvitationsService, useValue: f.invitations },
      { provide: IdentityService, useValue: f.identity }, { provide: UserProfileRepository, useValue: new UserProfileRepository(pool) }, { provide: SignupService, useValue: signup },
      { provide: APP_GUARD, useValue: new ActorContextGuard(f.identity, db) },
      { provide: APP_GUARD, useValue: new RbacGuard(new Reflector(), new WorkspaceResourceTenantResolver(new PlatformDbWorkspaceTenantLookup(db)), new ParamWorkspaceResolver()) },
      { provide: APP_FILTER, useClass: RbacExceptionFilter },
    ] }).compile();
    let app: NestFastifyApplication | undefined;
    try {
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.listen(0, "127.0.0.1"); const base = await app.getUrl();
      expect((await fetch(base + "/api/v1/members?workspaceId=" + workspace)).status).toBe(403);
      const callback = await fetch(base + "/api/v1/signup", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": uuidv7() }, body: JSON.stringify(f.request) });
      expect(callback.status).toBe(200); const landing = await callback.json() as { userId: string; workspaceRole: string };
      expect(landing.workspaceRole).toBe("viewer");
      const cookie = callback.headers.getSetCookie().find(value => value.startsWith("alter_access="))!.split(";")[0]!;
      const ownerSession = await f.identity.issueSignupSession(actor, tenant), ownerCookie = "alter_access=" + ownerSession.accessToken;
      const list = async (auth = ownerCookie) => { const response = await fetch(base + "/api/v1/members?workspaceId=" + workspace, { headers: { cookie: auth } }); return { status: response.status, body: await response.json() as import("../../../apps/platform-api/src/members/members.service").MemberView[] }; };
      let member = (await list()).body.find(row => row.userId === landing.userId)!;
      expect(member).toMatchObject({ role: "viewer", tenantOwner: false, workspaceId: workspace }); expect((await list(cookie)).status).toBe(200);
      const access = await fetch(base + "/api/v1/auth/me", { headers: { cookie } }); expect(access.status).toBe(200);
      expect(await access.json()).toMatchObject({ tenantRole: "member", workspaceRoles: [{ workspaceId: workspace, role: "viewer" }] });
      const ownerAccess = await fetch(base + "/api/v1/auth/me", { headers: { cookie: ownerCookie } });
      expect(await ownerAccess.json()).toMatchObject({ tenantRole: "owner" });
      const invite = await fetch(base + "/api/v1/members", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace, email: "http-refused@company.test", role: "admin" }) }); expect(invite.status).toBe(403);
      expect((await fetch(base + "/api/v1/members/invitations?workspaceId=" + workspace, { headers: { cookie } })).status).toBe(403);
      const patch = async (etag?: string) => fetch(base + "/api/v1/members/" + member.id, { method: "PATCH", headers: { cookie: ownerCookie, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify({ role: "editor" }) });
      expect((await patch()).status).toBe(428); expect((await patch('"stale"')).status).toBe(412); const changed = await patch(member.etag); expect(changed.status).toBe(200); member = await changed.json() as typeof member;
      expect((await list(cookie)).body.find(row => row.id === member.id)?.role).toBe("editor");
      const currentAccess = await fetch(base + "/api/v1/auth/me", { headers: { cookie } });
      expect(await currentAccess.json()).toMatchObject({ workspaceRoles: [{ workspaceId: workspace, role: "editor" }] });
      const reset = await fetch(base + "/api/v1/auth/password-reset", { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ email: "foreign@company.test" }) }); expect(reset.status).toBe(200); expect(await reset.json()).toEqual({ requested: true }); expect(f.provider.passwordResetRequests).toEqual(["admin@company.test"]);
      const removed = await fetch(base + "/api/v1/members/" + member.id + "?scope=workspace", { method: "DELETE", headers: { cookie: ownerCookie, "if-match": member.etag } }); expect(removed.status).toBe(200); expect((await list(cookie)).status).toBe(403);
      const replay = await fetch(base + "/api/v1/auth/callback?" + new URLSearchParams({ code: f.request.code, redirect_uri: f.request.redirectUri, code_verifier: f.request.codeVerifier, invitation: f.ticket })); expect(replay.status).toBe(403); expect(replay.headers.getSetCookie()).toEqual([]);
    } finally { await app?.close(); }
  }, 120000);
  it("removes and reapplies only the invitation schema through its paired rollback", async () => {
    const before = (await db.queryTenant(tenant, "SELECT id,role FROM workspace_members"));
    await apply("rollback/0033_drop_workspace_invitations.sql");
    expect((await admin.query("SELECT to_regclass('workspace_invitations') AS table")).rows[0].table).toBeNull();
    expect(await db.queryTenant(tenant, "SELECT id,role FROM workspace_members")).toEqual(before);
    await apply("0033_workspace_invitations.sql"); await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_invitations TO member_native");
    expect((await insert("reapplied@company.test"))[0]?.id).toBeDefined();
  });
});
