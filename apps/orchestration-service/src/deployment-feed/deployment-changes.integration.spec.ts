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
import { DeploymentChangesService, DeploymentChangesValidationError } from "./deployment-changes.service";
import { DeploymentChangesController } from "./deployment-changes.controller";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const AFTER = "2026-09-29T10:00:00.000Z";
describe.sequential("DeploymentChangesService PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let runtime: PostgresOrchestrationStoreProvider;
  let service: DeploymentChangesService;
  let redis: StartedRedisContainer;
  let issuer: Server;
  let app: NestFastifyApplication;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: container.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `deploy_feed_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    await admin.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(container.getConnectionUri());
    uri.username = role; uri.password = password;
    runtime = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.toString(), migrationsFolder });
    service = new DeploymentChangesService(runtime);
    redis = await new RedisContainer("redis:7.4.2-alpine").start();
    const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "deployment-feed", alg: "RS256", use: "sig" };
    issuer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((done) => issuer.listen(0, "127.0.0.1", done));
    const address = issuer.address();
    if (address === null || typeof address === "string") throw new Error("Issuer did not listen");
    const jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine", jwksUrl }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl }, new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl()))), runtime,
    );
    const module = await Test.createTestingModule({ controllers: [DeploymentChangesController], providers: [{ provide: DeploymentChangesService, useValue: service }, { provide: APP_GUARD, useValue: guard }] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
    for (const tenant of [TENANT, OTHER]) {
      await admin.withTenant(tenant, async (tx) => {
        await tx.query("INSERT INTO workflows (id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'Feed proof')", [`wf_${tenant}`, tenant, WORKSPACE]);
        for (const [version, stamp] of [[1, null], [2, "2026-09-29T09:00:00Z"], [3, AFTER], [4, "2026-09-29T11:00:00Z"], [5, "2026-09-29T12:00:00Z"]] as const) {
          await tx.query("INSERT INTO workflow_versions (id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status,last_deployed_at,last_deploy_kind) VALUES ($1,$2,$3,$4,'{}','v1','retired',$5,$6)", [`wfv_${tenant}_${version}`, tenant, `wf_${tenant}`, version, stamp, stamp === null ? null : version === 5 ? "restored" : "promoted"]);
        }
      });
    }
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    if (issuer) await new Promise<void>((done, reject) => issuer.close((error) => error ? reject(error) : done()));
    await redis?.stop(); await runtime?.close(); await admin?.close(); await container?.stop();
  }, 60_000);
  it("serves scoped deployment changes through live authentication and denies user/service callers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const machine = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 });
    const common = { tenant_id: `ten_${TENANT}`, auth_time: now, jti: randomBytes(12).toString("hex"), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 };
    const system = jwt({ ...common, principal_type: "system", principal: "system:platform-jobs", permissions: ["workflows:read"] });
    const url = `${await app.getUrl()}/api/v1/deployment-changes?changed_after=${encodeURIComponent(AFTER)}`;
    const accepted = await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": system } });
    expect(accepted.status).toBe(200);
    const body = await accepted.json() as { data: Array<{ workflow_id: string; workspace_id: string; version: number }> };
    expect(body.data.map((row) => row.version)).toEqual([5, 4]);
    expect(body.data.every((row) => row.workflow_id === `wf_${TENANT}` && row.workspace_id === `ws_${WORKSPACE}`)).toBe(true);
    expect((await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": system } })).status).toBe(401);
    const user = jwt({ ...common, jti: randomBytes(12).toString("hex"), user_id: "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890a4", workspace_id: `ws_${WORKSPACE}`, roles: ["admin"], permissions: ["workflows:read"], session_id: "test-session" });
    expect((await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": user } })).status).toBe(403);
    const serviceToken = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60, "https://alter.dev/claims/actor_type": "service", tenant_id: `ten_${TENANT}`, workspace_id: `ws_${WORKSPACE}`, roles: ["admin"], permissions: ["workflows:read"] });
    expect((await fetch(url, { headers: { authorization: `Bearer ${serviceToken}` } })).status).toBe(403);
    const validationToken = jwt({ ...common, jti: randomBytes(12).toString("hex"), principal_type: "system", principal: "system:platform-jobs", permissions: ["workflows:read"] });
    expect((await fetch(`${await app.getUrl()}/api/v1/deployment-changes?changed_after=9`, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": validationToken } })).status).toBe(400);
  });
  it("returns only strictly newer tenant changes, newest first, using the workflow workspace", async () => {
    expect(await service.since(`ten_${TENANT}`, AFTER)).toEqual([5, 4].map((version) => ({ workflow_id: `wf_${TENANT}`, workflow_version_id: `wfv_${TENANT}_${version}`, workspace_id: WORKSPACE, version, kind: version === 5 ? "restored" : "promoted", changed_at: `2026-09-29T${version === 5 ? "12" : "11"}:00:00.000Z` })));
    expect(await service.since(TENANT, "2026-09-29T12:00:00Z")).toEqual([]);
  });
  it.each(["bad", "9", "2026-09-29", "2026-09-29T10:00:00", "2026-02-30T10:00:00Z"])("rejects malformed timestamp %s", async (time) => {
    await expect(service.since(TENANT, time)).rejects.toBeInstanceOf(DeploymentChangesValidationError);
  });
  it("rejects malformed tenants", async () => {
    await expect(service.since("bad", AFTER)).rejects.toBeInstanceOf(DeploymentChangesValidationError);
  });
  it("bounds the result at 200", async () => {
    await admin.withTenant(TENANT, async (tx) => {
      await tx.query("INSERT INTO workflow_versions (id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status,last_deployed_at,last_deploy_kind) SELECT 'wfv_bound_'||n,$1,$2,n,'{}','v1','retired','2026-09-29T13:00:00Z','promoted' FROM generate_series(6,210) n", [TENANT, `wf_${TENANT}`]);
    });
    const rows = await service.since(TENANT, AFTER);
    expect(rows).toHaveLength(200);
    expect(rows.every((row) => row.workflow_id === `wf_${TENANT}` && row.changed_at === "2026-09-29T13:00:00.000Z")).toBe(true);
  });
  function jwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid: "deployment-feed", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(keys.privateKey).toString("base64url")}`;
  }
});
