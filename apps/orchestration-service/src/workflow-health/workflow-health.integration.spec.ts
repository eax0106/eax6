import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkflowHealthService } from "./workflow-health.service";
import { WorkflowReadController } from "../workflow-read/workflow-read.controller";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { SecurityModule } from "../security.module";
import { identityTenantGatewayEnvironment, orchestrationStore } from "../orchestration-infrastructure.module";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1", workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const otherTenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2", otherWorkspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const id = (prefix: string, n: number) => `${prefix}_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
const workflow = id("wf", 1), empty = id("wf", 2), unknown = id("wf", 3), foreign = id("wf", 4);

describe.sequential("workflow health on restricted PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let runtimeUri: string;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `health_${randomBytes(5).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      for (const wf of [workflow, empty, unknown]) await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Health fixture')", [wf, tenant, workspace]);
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Other workspace')", [foreign, tenant, otherWorkspace]);
      for (let n = 1; n <= 24; n++) {
        // 21st recent, old, future and other-workspace evidence must not enter the sample.
        const date = new Date(Date.now() + (n === 23 ? 86400000 : n === 22 ? -8 * 86400000 : -n * 3600000)).toISOString();
        const run = id("run", n), node = id("node", n), wf = n === 24 ? foreign : n === 22 || n === 23 ? empty : workflow, ws = n === 24 ? otherWorkspace : workspace;
        await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,status,created_at) VALUES($1,$2,$3,'workflow',$4,'completed',$5)", [run, tenant, ws, wf, date]);
        await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status,error) VALUES($1,$2,$3,'step','tool',$4,$5)", [node, tenant, run, n > 16 ? "recovered" : "succeeded", n > 16 ? { error_code: "TOOL_CALL_VALIDATION_FAILED" } : null]);
        if (n > 14) for (let duplicate = 0; duplicate < 2; duplicate++) await tx.query("INSERT INTO recovery_actions(id,tenant_id,run_id,node_execution_id,failure_class,strategy,policy_version,resolved_at) VALUES($1,$2,$3,$4,'infrastructure_failure','retry','native',now())", [id("rec", n * 10 + duplicate), tenant, run, node]);
        await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'mechanical',$4)", [id("ver", n), tenant, run, n <= 9 ? "pass" : "fail"]);
        await tx.query("INSERT INTO run_outcomes(id,tenant_id,workspace_id,run_id,mode,eligible,verdict,human_rescue,critical_external_error,recovery_count,decided_at) VALUES($1,$2,$3,$4,'workflow',true,$5,false,false,0,now())", [randomUUID(), tenant, ws, run, n <= 16 ? "completed_verified" : "failed"]);
      }
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,status) VALUES($1,$2,$3,'workflow',$4,'running')", [id("run", 100), tenant, workspace, unknown]);
      await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES($1,$2,$3,'step','tool','running')", [id("node", 100), tenant, id("run", 100)]);
      await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'mechanical','warn')", [id("ver", 100), tenant, id("run", 100)]);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password;
    runtimeUri = uri.href;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: runtimeUri, migrationsFolder });
    expect((await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 120000);
  afterAll(async () => { await store?.close(); await admin?.close(); await postgres?.stop(); });
  const health = (wf: string, ws = workspace, ten = tenant) => new WorkflowHealthService(store).get(`ten_${ten}`, `ws_${ws}`, wf);

  it("uses only the latest 20 runs within seven days and averages four actual dimensions with worst status", async () => {
    const result = await health(workflow);
    expect(result.window.sampledRuns).toBe(20); expect(Date.parse(result.window.endAt) - Date.parse(result.window.startAt)).toBe(7 * 86400000);
    expect(result.dimensions.validation).toMatchObject({ passed: 16, observations: 20, score: 80, status: "healthy" });
    expect(result.dimensions.availability).toMatchObject({ passed: 14, observations: 20, score: 70, status: "warning" });
    expect(result.dimensions.correctness).toMatchObject({ passed: 9, observations: 20, score: 45, status: "critical" });
    expect(result.dimensions.reliability).toMatchObject({ passed: 16, observations: 20, score: 80, status: "healthy" });
    expect(result.overallScore).toBe(68.75); expect(result.status).toBe("critical"); expect(result.recentFailures).toBe(4);
    // Thresholds are strict: 50 is warning, 80 is healthy; neither follows the mean.
    await store.withTenant(tenant, tx => tx.query("UPDATE verification_results SET verdict='pass' WHERE id=$1", [id("ver", 10)]));
    expect((await health(workflow)).status).toBe("warning");
    await store.withTenant(tenant, async tx => {
      await tx.query("UPDATE verification_results SET verdict='pass' WHERE id=ANY($1::text[])", [[11,12,13,14,15,16].map(n => id("ver", n))]);
      await tx.query("DELETE FROM recovery_actions WHERE run_id=ANY($1::text[])", [Array.from({length:20},(_,n)=>id("run",n+1))]);
    });
    const atEighty = await health(workflow); expect(atEighty.dimensions.correctness.score).toBe(80); expect(atEighty.status).toBe("healthy"); expect(atEighty.overallScore).toBe(85);
  });
  it("refuses other workspaces and tenants and invalid identities", async () => {
    await expect(health(foreign)).rejects.toThrow(/not found/i);
    await expect(health(workflow, otherWorkspace)).rejects.toThrow(/not found/i);
    await expect(health(workflow, workspace, otherTenant)).rejects.toThrow(/not found/i);
    await expect(new WorkflowHealthService(store).get("invalid", `ws_${workspace}`, workflow)).rejects.toThrow(/identities/);
  });
  it("keeps empty and unconfirmed evidence unknown without creating scores", async () => {
    const result = await health(empty); expect(result.window.sampledRuns).toBe(0); expect(result.overallScore).toBeNull(); expect(result.status).toBe("not_enough_data");
    for (const dimension of Object.values(result.dimensions)) expect(dimension).toMatchObject({ score: null, observations: 0, passed: 0, status: "not_enough_data" });
    const pending = await health(unknown); expect(pending.window.sampledRuns).toBe(1); expect(pending.overallScore).toBeNull(); expect(pending.status).toBe("not_enough_data");
    for (const dimension of Object.values(pending.dimensions)) expect(dimension.observations).toBe(0);
  });

  it("serves measured health through real signed machine/actor HTTP guards and rejects replay or foreign scope", async () => {
    const redis = await new RedisContainer("redis:7.4.2-alpine").start(), pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuer = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "health-native", alg: "RS256", use: "sig" }] })); });
    await new Promise<void>(done => issuer.listen(0, "127.0.0.1", done));
    const jwks = `http://127.0.0.1:${(issuer.address() as { port: number }).port}/jwks`;
    for (const [name, value] of Object.entries({ NODE_ENV: "test", AUTH0_DOMAIN: "health.test", AUTH0_API_AUDIENCE: "alter-engine", AUTH0_JWKS_URL: jwks,
      ACTOR_TOKEN_ISSUER: "alter-platform-api.identity-broker", ACTOR_TOKEN_AUDIENCE: "alter-engine", ACTOR_TOKEN_JWKS_URL: jwks,
      REDIS_ENDPOINT: redis.getConnectionUrl(), AWS_REGION: "ap-south-1", ALTER_ARTIFACTS_BUCKET_PARAM: "/fixture/artifacts",
      ORCHESTRATION_DATABASE_AUTHENTICATION: "static", ORCHESTRATION_DATABASE_URL: runtimeUri })) vi.stubEnv(name, value);
    let app: NestFastifyApplication | undefined, guardStore: PostgresOrchestrationStoreProvider | undefined;
    try {
      guardStore = orchestrationStore(identityTenantGatewayEnvironment(process.env));
      const module = await Test.createTestingModule({ imports: [SecurityModule], controllers: [WorkflowReadController], providers: [
        { provide: WorkflowReadService, useValue: new WorkflowReadService(store) }, { provide: WorkflowHealthService, useValue: new WorkflowHealthService(store) },
      ] }).compile();
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.listen(0, "127.0.0.1");
      const jwt = (claims: Record<string, unknown>) => { const input = [{ alg: "RS256", kid: "health-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`; };
      const headers = (overrides: Record<string, unknown> = {}) => { const now = Math.floor(Date.now() / 1000); return {
        authorization: `Bearer ${jwt({ iss: "https://health.test/", aud: "alter-engine", iat: now, exp: now + 60 })}`,
        "x-alter-actor-token": jwt({ user_id: `usr_${tenant}`, tenant_id: `ten_${tenant}`, workspace_id: `ws_${workspace}`, roles: ["viewer"], permissions: [], session_id: "health-native", auth_time: now, jti: randomUUID(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60, ...overrides }),
      }; };
      const url = `${await app.getUrl()}/api/v1/workflows/${workflow}/health`;
      expect((await fetch(url)).status).toBe(401);
      const reused = headers(), actual = await fetch(url, { headers: reused }); expect(actual.status).toBe(200);
      expect(await actual.json()).toMatchObject({ workflowId: workflow, window: { sampledRuns: 20 }, dimensions: { correctness: { score: 80 } } });
      expect((await fetch(url, { headers: reused })).status).toBe(401);
      expect((await fetch(url, { headers: headers({ workspace_id: `ws_${otherWorkspace}` }) })).status).toBe(404);
      expect((await fetch(url, { headers: headers({ tenant_id: `ten_${otherTenant}` }) })).status).toBe(404);
    } finally { await app?.close(); await guardStore?.close(); vi.unstubAllEnvs(); await new Promise<void>(done => issuer.close(() => done())); await redis.stop(); }
  }, 120000);
});
