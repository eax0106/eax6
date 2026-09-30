import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { APP_GUARD } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineWorkspaceExportService, EngineWorkspaceExportValidationError } from "./workspace-export.service";
import { EngineWorkspaceExportController } from "./workspace-export.controller";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const FOREIGN = "018f4d6e-2b4a-7a3e-8c1a-1234567890f2";
const collections = ["workflows", "workflow_versions", "runs"] as const;
describe.sequential("Engine workspace export PostgreSQL and listening HTTP", () => {
  let container: StartedPostgreSqlContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let runtime: PostgresOrchestrationStoreProvider;
  let service: EngineWorkspaceExportService;
  let redis: StartedRedisContainer;
  let issuer: Server;
  let app: NestFastifyApplication;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();
    const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: container.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `export_read_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    await admin.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(container.getConnectionUri()); uri.username = role; uri.password = password;
    runtime = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.toString(), migrationsFolder });
    service = new EngineWorkspaceExportService(runtime);
    for (const tenant of [TENANT, OTHER]) {
      for (const workspace of [WORKSPACE, FOREIGN]) {
        await admin.withTenant(tenant, async (tx) => {
          const suffix = `${tenant}_${workspace}`;
          await tx.query("INSERT INTO workflows (id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'Archive workflow')", [`wf_${suffix}`, tenant, workspace]);
          await tx.query("INSERT INTO workflow_versions (id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) VALUES ($1,$2,$3,1,$4,'v1')", [`wfv_${suffix}`, tenant, `wf_${suffix}`, JSON.stringify({ password: "fixture-content-not-metadata" })]);
          await tx.query("INSERT INTO runs (id,tenant_id,workspace_id,parent_kind,workflow_id,status) VALUES ($1,$2,$3,'workflow',$4,'completed')", [`run_${suffix}`, tenant, workspace, `wf_${suffix}`]);
        });
      }
    }
    redis = await new RedisContainer("redis:7.4.2-alpine").start();
    const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "export-read", alg: "RS256", use: "sig" };
    issuer = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>((done) => issuer.listen(0, "127.0.0.1", done));
    const address = issuer.address();
    if (!address || typeof address === "string") throw new Error("Issuer did not listen");
    const jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine", jwksUrl }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl }, new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl()))), runtime,
    );
    const module = await Test.createTestingModule({ controllers: [EngineWorkspaceExportController], providers: [{ provide: EngineWorkspaceExportService, useValue: service }, { provide: APP_GUARD, useValue: guard }] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    if (issuer) await new Promise<void>((done, reject) => issuer.close((error) => error ? reject(error) : done()));
    await redis?.stop(); await runtime?.close(); await admin?.close(); await container?.stop();
  }, 60_000);

  it.each(collections)("reads only workspace %s metadata and no content/cost fields", async (collection) => {
    const result = await service.page(`ten_${TENANT}`, { workspace_id: `ws_${WORKSPACE}`, collection });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toContain(`${TENANT}_${WORKSPACE}`);
    expect(result.data[0]?.workspace_id).toBe(`ws_${WORKSPACE}`);
    expect(result.page).toEqual({ has_more: false, next_cursor: null, limit: 200 });
    expect(JSON.stringify(result)).not.toMatch(/fixture-content|compiled_dag|password|internal_cost|margin|input_payload|output_payload/);
  });
  it("uses a restricted read-only role and preserves scope for another tenant and empty workspace", async () => {
    await runtime.withTenant(TENANT, async (tx) => {
      const roles = await tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await expect(tx.query("DELETE FROM workflows")).rejects.toThrow(/permission denied/);
    });
    const other = await service.page(`ten_${OTHER}`, { workspace_id: `ws_${WORKSPACE}`, collection: "runs" });
    expect(other.data).toHaveLength(1);
    expect(other.data[0]?.id).toContain(OTHER);
    expect((await service.page(`ten_${TENANT}`, { workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ff", collection: "runs" })).data).toEqual([]);
  });
  it("requires live machine and actor tokens, system read rights, strict query and replay protection", async () => {
    const now = Math.floor(Date.now() / 1000);
    const machine = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 });
    const common = { tenant_id: `ten_${TENANT}`, auth_time: now, iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 };
    const token = () => jwt({ ...common, jti: randomBytes(12).toString("hex"), principal_type: "system", principal: "system:platform-jobs", permissions: ["workflows:read", "runs:read"] });
    const url = `${await app.getUrl()}/api/v1/workspace-export-metadata?workspace_id=ws_${WORKSPACE}&collection=runs`;
    const actorToken = token();
    const headers = { authorization: `Bearer ${machine}`, "x-alter-actor-token": actorToken };
    const accepted = await fetch(url, { headers });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect((await accepted.json() as { data: unknown[] }).data).toHaveLength(1);
    expect((await fetch(url, { headers })).status).toBe(401);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(`${url}&tenant_id=ten_${OTHER}`, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": token() } })).status).toBe(400);
    const user = jwt({ ...common, jti: randomBytes(12).toString("hex"), user_id: "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890a4", workspace_id: `ws_${WORKSPACE}`, roles: ["admin"], permissions: ["workflows:read", "runs:read"], session_id: "export-test" });
    expect((await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": user } })).status).toBe(403);
    const serviceToken = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60, "https://alter.dev/claims/actor_type": "service", tenant_id: `ten_${TENANT}`, workspace_id: `ws_${WORKSPACE}`, roles: ["admin"], permissions: ["workflows:read", "runs:read"] });
    expect((await fetch(url, { headers: { authorization: `Bearer ${serviceToken}` } })).status).toBe(403);
    const limited = jwt({ ...common, jti: randomBytes(12).toString("hex"), principal_type: "system", principal: "system:platform-jobs", permissions: ["workflows:read"] });
    expect((await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": limited } })).status).toBe(403);
  });
  it.each([
    {}, { workspace_id: "bad", collection: "runs" }, { workspace_id: `ws_${WORKSPACE}`, collection: "secrets" },
    { workspace_id: `ws_${WORKSPACE}`, collection: "runs", limit: 201 },
    { workspace_id: `ws_${WORKSPACE}`, collection: "runs", limit: 0 },
    { workspace_id: `ws_${WORKSPACE}`, collection: "runs", cursor: "bad" },
    { workspace_id: `ws_${WORKSPACE}`, collection: "runs", tenant_id: OTHER },
  ])("rejects invalid query %j", async (query) => {
    await expect(service.page(`ten_${TENANT}`, query)).rejects.toBeInstanceOf(EngineWorkspaceExportValidationError);
  });
  it("rejects malformed tenant before opening a transaction", async () => {
    await expect(service.page("bad", { workspace_id: `ws_${WORKSPACE}`, collection: "runs" })).rejects.toBeInstanceOf(EngineWorkspaceExportValidationError);
  });
  it.each(collections)("paginates all %s without truncation or duplicates and binds cursors to source scope", async (collection) => {
    await admin.withTenant(TENANT, async (tx) => {
      if (collection === "workflows") await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) SELECT 'wf_page_'||lpad(n::text,4,'0'),$1,$2,'Paged' FROM generate_series(1,201) n", [TENANT, WORKSPACE]);
      else if (collection === "workflow_versions") await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) SELECT 'wfv_page_'||lpad(n::text,4,'0'),$1,$2,n+1,'{}','v1' FROM generate_series(1,201) n", [TENANT, `wf_${TENANT}_${WORKSPACE}`]);
      else await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id) SELECT 'run_page_'||lpad(n::text,4,'0'),$1,$2,'workflow',$3 FROM generate_series(1,201) n", [TENANT, WORKSPACE, `wf_${TENANT}_${WORKSPACE}`]);
    });
    const first = await service.page(TENANT, { workspace_id: `ws_${WORKSPACE}`, collection });
    expect(first.data).toHaveLength(200); expect(first.page.has_more).toBe(true);
    const second = await service.page(TENANT, { workspace_id: `ws_${WORKSPACE}`, collection, cursor: first.page.next_cursor });
    expect(second.data).toHaveLength(2); expect(second.page.has_more).toBe(false);
    expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(202);
    await expect(service.page(TENANT, { workspace_id: `ws_${FOREIGN}`, collection, cursor: first.page.next_cursor })).rejects.toBeInstanceOf(EngineWorkspaceExportValidationError);
    await expect(service.page(OTHER, { workspace_id: `ws_${WORKSPACE}`, collection, cursor: first.page.next_cursor })).rejects.toBeInstanceOf(EngineWorkspaceExportValidationError);
    const foreign = Buffer.from(JSON.stringify({ workspace_id: `ws_${WORKSPACE}`, collection, id: `${collection === "runs" ? "run" : collection === "workflows" ? "wf" : "wfv"}_${TENANT}_${FOREIGN}` })).toString("base64url");
    await expect(service.page(TENANT, { workspace_id: `ws_${WORKSPACE}`, collection, cursor: foreign })).rejects.toBeInstanceOf(EngineWorkspaceExportValidationError);
  });
  function jwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid: "export-read", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(keys.privateKey).toString("base64url")}`;
  }
});
