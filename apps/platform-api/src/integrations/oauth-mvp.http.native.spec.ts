import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import { RbacModule } from "../rbac";
import { PlatformDb } from "../signup/platform-db";
import { IdentityService } from "../identity/identity.service";
import { PgSessionStore } from "../identity/session-store";
import { IdempotencyInterceptor, PgIdempotencyStore } from "../idempotency";
import { createCreditPurchaseNativeDriver, type CreditPurchaseNativeDriver } from "../credit-purchases/testing/credit-purchase-native-driver";
import { IntegrationController } from "./integration.controller";
import { IntegrationRepository } from "./integration.repository";
import { IntegrationService, tokenReference } from "./integration.service";
import type { ConnectorRuntimeConfigMap } from "./integration.service";
import type { OAuthHttpClient } from "./adapters/oauth/oauth-http-client";

const database = process.env.DATABASE_URL;
describe.skipIf(!database).sequential("MVP OAuth over authenticated native HTTP and durable state", () => {
  let d: CreditPurchaseNativeDriver, app: NestFastifyApplication, identity: IdentityService, cookie: string, repository: IntegrationRepository;
  const workspace = uuidv7(), otherWorkspace = uuidv7();
  const secrets = createMockMutableSecretsProvider({ secrets: { "/fixture/client": "native-client", "/fixture/secret": "native-secret" } });
  const exchange = vi.fn<OAuthHttpClient["exchangeCode"]>(async () => ({ accessToken: "native-access", refreshToken: null, tokenType: "bearer", expiresAt: null, grantedScopes: "repo" }));
  const account = vi.fn<OAuthHttpClient["fetchAccountId"]>(async () => "native-account");
  const sync = vi.fn(async () => undefined);
  beforeAll(async () => {
    d = await createCreditPurchaseNativeDriver(database!);
    await d.admin.query("INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'OAuth','active'),($3,$4,'Other','active')", [workspace, d.tenantA, otherWorkspace, d.tenantB]);
    await d.admin.query("INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,'editor'),($5,$6,$7,$8,'editor')", [uuidv7(), d.tenantA, workspace, d.userA, uuidv7(), d.tenantB, otherWorkspace, d.userB]);
    identity = new IdentityService({} as never, new PgSessionStore(d.pool));
    cookie = `alter_access=${(await identity.issueSignupSession(d.userA, d.tenantA)).accessToken}`;
    repository = new IntegrationRepository(d.pool);
    const service = new IntegrationService(repository, secrets, { exchangeCode: exchange, fetchAccountId: account, revoke: async () => ({ revokedRemotely: false }) },
      { github: { configured: true, clientIdSecretRef: "/fixture/client", clientSecretSecretRef: "/fixture/secret" } } as ConnectorRuntimeConfigMap, { upsert: sync } as never);
    const module = await Test.createTestingModule({ imports: [RbacModule], controllers: [IntegrationController], providers: [
      { provide: IntegrationService, useValue: service }, IdempotencyInterceptor,
      { provide: PgIdempotencyStore, useValue: new PgIdempotencyStore(d.pool, 60_000) },
    ] }).overrideProvider(IdentityService).useValue(identity).overrideProvider(PlatformDb).useValue(new PlatformDb(d.pool)).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await d?.close(); }, 60_000);
  beforeEach(() => { vi.clearAllMocks(); account.mockResolvedValue("native-account"); });
  const post = (action: string, payload: Record<string, unknown>, session = cookie, key = uuidv7()) => app.inject({
    method: "POST", url: `/api/v1/integrations/github/actions/${action}`, headers: { cookie: session, "idempotency-key": key }, payload,
  });
  const authorize = async (connectionId?: string) => {
    const response = await post("authorize", { redirect_uri: "http://localhost:5173/app/connections/callback", ...(connectionId ? { connection_id: connectionId } : {}) });
    expect(response.statusCode).toBe(200); return response.json() as { state: string; authorize_url: string };
  };
  const connect = async () => {
    const auth = await authorize();
    const response = await post("callback", { state: auth.state, code: "native-code" });
    expect(response.statusCode).toBe(200); return response.json() as { id: string; status: string };
  };

  it("creates through the real guards, stores state/tokens and replays callback once", async () => {
    const auth = await authorize();
    expect(new URL(auth.authorize_url).searchParams.get("state")).toBe(auth.state);
    expect(await repository.findState(d.tenantB, auth.state)).toBeUndefined();
    const key = uuidv7(), body = { state: auth.state, code: "native-code" };
    const response = await post("callback", body, cookie, key);
    expect(response.statusCode).toBe(200);
    const saved = response.json(); expect(saved).toMatchObject({ status: "connected", engine_synced: true, external_account_id: "native-account" });
    expect(await repository.findState(d.tenantA, auth.state)).toBeUndefined();
    expect(await secrets.getSecret(tokenReference(d.tenantA, workspace, saved.id))).toContain("native-access");
    expect((await post("callback", body, cookie, key)).json()).toEqual(saved);
    expect(exchange).toHaveBeenCalledOnce(); expect(sync).toHaveBeenCalledOnce();
  });
  it("reconnect binds a durable target and keeps the original identity", async () => {
    const connection = await connect(); await repository.revokeConnection(d.tenantA, workspace, connection.id);
    const auth = await authorize(connection.id);
    expect(await repository.findState(d.tenantA, auth.state)).toMatchObject({ connectionId: connection.id, createdBy: d.userA });
    const response = await post("callback", { state: auth.state, code: "renewed-code" });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ id: connection.id, status: "connected" });
    expect(await repository.listConnections(d.tenantA, workspace)).toHaveLength(1);
  });
  it("rejects a different provider account without changing target credentials", async () => {
    const connection = await connect(), reference = tokenReference(d.tenantA, workspace, connection.id);
    const before = await secrets.getSecret(reference), auth = await authorize(connection.id);
    account.mockResolvedValueOnce("different-account");
    const response = await post("callback", { state: auth.state, code: "wrong-account" });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error_code: "INTEGRATION_RECONNECT_ACCOUNT_MISMATCH" });
    expect(await secrets.getSecret(reference)).toBe(before); expect(await repository.listConnections(d.tenantA, workspace)).toHaveLength(1);
  });
  it("refuses missing, expired, foreign actor/workspace/tenant state before provider calls", async () => {
    expect((await post("callback", { code: "code", state: "missing" })).statusCode).toBe(400);
    for (const change of ["expired", "actor", "workspace"] as const) {
      const auth = await authorize();
      if (change === "expired") await d.admin.query("UPDATE oauth_states SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [auth.state]);
      if (change === "actor") await d.admin.query("UPDATE oauth_states SET created_by=$1 WHERE id=$2", [d.userB, auth.state]);
      if (change === "workspace") await d.admin.query("UPDATE oauth_states SET workspace_id=$1 WHERE id=$2", [otherWorkspace, auth.state]);
      expect((await post("callback", { code: "code", state: auth.state })).statusCode).toBe(400);
    }
    const auth = await authorize(), otherCookie = `alter_access=${(await identity.issueSignupSession(d.userB, d.tenantB)).accessToken}`;
    expect((await post("callback", { code: "code", state: auth.state }, otherCookie)).statusCode).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });
  it("refuses foreign reconnect targets and malformed input", async () => {
    const foreign = await repository.createConnection(d.tenantB, { id: uuidv7(), workspaceId: otherWorkspace, connector: "github", externalAccountId: "other", scopes: "repo" });
    expect((await post("authorize", { redirect_uri: "http://localhost:5173/app/connections/callback", connection_id: foreign.id })).statusCode).toBe(404);
    expect((await post("authorize", { redirect_uri: "http://localhost:5173/app/connections/callback", connection_id: "invalid" })).statusCode).toBe(400);
  });
  it("reconnect migration is idempotent and has a working rollback", async () => {
    const directory = join(__dirname, "../db/migrations");
    await d.admin.query(readFileSync(join(directory, "rollback/0039_remove_oauth_reconnect_state.sql"), "utf8"));
    expect((await d.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='oauth_states' AND column_name='connection_id'", [d.schema])).rows).toHaveLength(0);
    for (let repeat = 0; repeat < 2; repeat++) await d.admin.query(readFileSync(join(directory, "0039_oauth_reconnect_state.sql"), "utf8"));
    expect((await d.admin.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='oauth_states' AND column_name='connection_id'", [d.schema])).rows).toEqual([{ is_nullable: "YES" }]);
  });
  it("refuses anonymous and downgraded members", async () => {
    expect((await post("authorize", {}, "")).statusCode).toBe(403);
    await d.admin.query("UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1", [workspace]);
    await d.admin.query("UPDATE tenant_members SET role='member' WHERE tenant_id=$1 AND user_id=$2", [d.tenantA, d.userA]);
    expect((await post("authorize", {})).statusCode).toBe(403); expect(exchange).not.toHaveBeenCalled();
  });
});
