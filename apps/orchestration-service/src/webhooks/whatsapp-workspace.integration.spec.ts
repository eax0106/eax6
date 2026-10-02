import { createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WhatsappAccountRegistryService } from "./whatsapp-account-registry.service";
import { WhatsappAccountsController } from "./whatsapp-accounts.controller";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const otherTenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const otherWorkspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const migrationsFolder = resolve("apps/orchestration-service/drizzle");
const uuid = () => { const id = randomUUID(); return `${id.slice(0, 14)}7${id.slice(15)}`; };
const path = "/api/v1/channels/whatsapp/accounts";

describe.sequential("WhatsApp account workspace routes through native HTTP", () => {
  let postgres: StartedPostgreSqlContainer, redis: StartedRedisContainer;
  let admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let app: NestFastifyApplication, registry: WhatsappAccountRegistryService, key: KeyObject;
  let ownId: string, otherId: string, foreignId: string;
  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withPassword(randomBytes(24).toString("hex")).start(),
      new RedisContainer("redis:7.4.2-alpine").start(),
    ]);
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `wa_workspace_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    registry = new WhatsappAccountRegistryService(store);
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); key = pair.privateKey;
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "wa-workspace", alg: "RS256", use: "sig" };
    const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine" }, { fetch: fetchJwks }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://identity.test/jwks" },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())), { fetch: fetchJwks }), store,
    );
    const module = await Test.createTestingModule({ controllers: [WhatsappAccountsController], providers: [
      { provide: WhatsappAccountRegistryService, useValue: registry }, { provide: APP_GUARD, useValue: guard },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
    const register = (tenantId: string, workspaceId: string, phone: string) => registry.register(tenantId, {
      workspaceId, phoneNumberId: phone, wabaId: "fixture", accessTokenRef: "env:WA_WORKSPACE_FIXTURE", status: "connected",
      monitoringConfig: {}, mediaConfig: {}, escalationRules: [],
    });
    ownId = (await register(tenant, workspace, "workspace-own")).id;
    otherId = (await register(tenant, otherWorkspace, "workspace-other")).id;
    foreignId = (await register(otherTenant, workspace, "tenant-other")).id;
  }, 120_000);
  afterAll(async () => { await app?.close(); await store?.close(); await admin?.close(); await Promise.all([postgres?.stop(), redis?.stop()]); });
  function jwt(payload: Record<string, unknown>) {
    const input = [{ alg: "RS256", kid: "wa-workspace" }, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${input}.${createSign("RSA-SHA256").update(input).sign(key).toString("base64url")}`;
  }
  function headers(workspaceId = workspace, tenantId = tenant) {
    const now = Math.floor(Date.now() / 1000);
    return { authorization: `Bearer ${jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 })}`,
      "x-alter-actor-token": jwt({ user_id: `usr_${tenant}`, tenant_id: `ten_${tenantId}`, workspace_id: `ws_${workspaceId}`,
        roles: ["admin"], permissions: ["integrations:read", "integrations:write"], session_id: "wa-workspace-proof", auth_time: now, jti: uuid(),
        iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }) };
  }
  async function request(method: string, suffix = "", body?: unknown, workspaceId = workspace, tenantId = tenant) {
    return fetch((await app.getUrl()) + path + suffix, { method, headers: { ...headers(workspaceId, tenantId), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it("lists only the authenticated workspace using a role held to row security", async () => {
    expect((await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const response = await request("GET"); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accounts: [{ id: ownId, workspaceId: `ws_${workspace}` }] });
    const second = await request("GET", "", undefined, otherWorkspace); expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ accounts: [{ id: otherId, workspaceId: `ws_${otherWorkspace}` }] });
  });
  it("registers in the authenticated workspace and requires the submitted workspace to agree", async () => {
    const input = { workspaceId: workspace, phoneNumberId: "workspace-new", wabaId: "fixture", accessTokenRef: "env:WA_WORKSPACE_FIXTURE" };
    const response = await request("POST", "", input); expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ workspaceId: `ws_${workspace}`, tenantId: `ten_${tenant}` });
    expect((await request("POST", "", { ...input, phoneNumberId: "workspace-disagrees", workspaceId: `ws_${otherWorkspace}` })).status).toBe(403);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id FROM whatsapp_accounts WHERE phone_number_id='workspace-disagrees'"))).rows).toEqual([]);
  });
  it("updates and deletes only accounts in the authenticated workspace", async () => {
    const config = { monitoringConfig: { enabled: true }, mediaConfig: { limit: 10 }, escalationRules: [{ id: "rule", target: "fixture" }] };
    const updated = await request("POST", `/${ownId}/configuration`, config); expect(updated.status).toBe(201);
    expect(await updated.json()).toMatchObject({ id: ownId, ...config });
    for (const id of [otherId, foreignId]) {
      expect((await request("POST", `/${id}/configuration`, config)).status).toBe(404);
      expect((await request("DELETE", `/${id}`)).status).toBe(404);
    }
    expect((await store.withTenant(tenant, tx => tx.query("SELECT monitoring_config,media_config,escalation_rules FROM whatsapp_accounts WHERE id=$1", [otherId]))).rows)
      .toEqual([{ monitoring_config: {}, media_config: {}, escalation_rules: [] }]);
    expect((await request("DELETE", `/${ownId}`)).status).toBe(204);
    expect((await request("DELETE", `/${ownId}`)).status).toBe(404);
  });
  it("requires both valid credentials and consumes each signed actor token once", async () => {
    const url = (await app.getUrl()) + path;
    expect((await fetch(url)).status).toBe(401);
    const signed = headers();
    expect((await fetch(url, { headers: { ...signed, authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: signed.authorization } })).status).toBe(401);
    expect((await fetch(url, { headers: signed })).status).toBe(200);
    expect((await fetch(url, { headers: signed })).status).toBe(401);
  });
});
