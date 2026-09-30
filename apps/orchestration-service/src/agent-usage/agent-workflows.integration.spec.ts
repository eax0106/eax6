import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { APP_GUARD } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrchestrationTenantStore } from "../runs/run-observability.service";
import { AgentWorkflowsService, AgentWorkflowsValidationError } from "./agent-workflows.service";
import { AgentWorkflowsController } from "./agent-workflows.controller";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WS_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const WS_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890f2";
const AGENT = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const OTHER_AGENT = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
let counter = 0;

// Section 17: the workflows an agent worked in lately, on a real orchestration_db.
describe.sequential("AgentWorkflowsService", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let service: AgentWorkflowsService;
  let runtimeStore: PostgresOrchestrationStoreProvider;
  let redis: StartedRedisContainer;
  let app: NestFastifyApplication;
  let issuer: Server;
  const role = `agent_feed_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const step = async (tenant: string, workspace: string, workflow: string, agent: string, daysAgo: number) => {
    const n = ++counter;
    const runId = `run_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
    await store.withTenant(tenant, async (tx) => {
      await tx.query(
        "INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [workflow, tenant, workspace, `Workflow ${workflow}`],
      );
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,workflow_id,parent_kind) VALUES ($1,$2,$3,$4,'workflow')", [runId, tenant, workspace, workflow]);
      await tx.query(
        `INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,agent_id,status,started_at)
         VALUES ($1,$2,$3,'n','LLMTask',$4,'succeeded', now() - make_interval(days => $5))`,
        [`node_${n}`, tenant, runId, agent, daysAgo],
      );
    });
  };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    await store.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const runtimeUrl = new URL(postgres.getConnectionUri());
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeStore = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: runtimeUrl.toString(), migrationsFolder });
    service = new AgentWorkflowsService(runtimeStore as unknown as OrchestrationTenantStore);
    redis = await new RedisContainer("redis:7.4.2-alpine").start();
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "agent-feed-key", alg: "RS256", use: "sig" };
    issuer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolveListening) => issuer.listen(0, "127.0.0.1", resolveListening));
    const address = issuer.address();
    if (address === null || typeof address === "string") throw new Error("Issuer did not listen");
    const jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine", jwksUrl }),
      new ActorTokenValidator(
        { issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())),
      ), runtimeStore,
    );
    const module = await Test.createTestingModule({
      controllers: [AgentWorkflowsController],
      providers: [{ provide: AgentWorkflowsService, useValue: service }, { provide: APP_GUARD, useValue: guard }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (issuer) await new Promise<void>((resolveClosed, reject) => issuer.close((error) => error ? reject(error) : resolveClosed()));
    await redis?.stop();
    await runtimeStore?.close();
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("lists each workflow the agent ran in within 30 days, once, across the tenant's workspaces", async () => {
    await step(TENANT, WS_A, "wf_a", AGENT, 1);
    await step(TENANT, WS_A, "wf_a", AGENT, 2);
    await step(TENANT, WS_B, "wf_b", AGENT, 3);
    await step(TENANT, WS_A, "wf_old", AGENT, 45);
    await step(TENANT, WS_A, "wf_other_agent", OTHER_AGENT, 1);
    await step(OTHER_TENANT, WS_A, "wf_foreign", AGENT, 1);

    await expect(service.recentWorkflows(`ten_${TENANT}`, AGENT)).resolves.toEqual([
      { workflow_id: "wf_a", workspace_id: WS_A, name: "Workflow wf_a" },
      { workflow_id: "wf_b", workspace_id: WS_B, name: "Workflow wf_b" },
    ]);
  });

  it("refuses a malformed tenant or agent id before reading", async () => {
    await expect(service.recentWorkflows("nope", AGENT)).rejects.toBeInstanceOf(AgentWorkflowsValidationError);
    await expect(service.recentWorkflows(`ten_${TENANT}`, "agt_1")).rejects.toBeInstanceOf(AgentWorkflowsValidationError);
  });

  it("serves the system caller through live JWT and Redis guards, and denies user and service callers", async () => {
    const agent = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
    await step(TENANT, WS_A, "wf_live", agent, 1);
    await step(OTHER_TENANT, WS_B, "wf_foreign_live", agent, 1);
    const url = `${await app.getUrl()}/api/v1/agents/${agent}/workflows`;
    const now = Math.floor(Date.now() / 1000);
    const machine = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 });
    const common = { tenant_id: `ten_${TENANT}`, auth_time: now, jti: randomBytes(12).toString("hex"), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 };
    const system = jwt({ ...common, principal_type: "system", principal: "system:platform-jobs", permissions: ["workflows:read"] });
    const accepted = await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": system } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ data: [{ workflow_id: "wf_live", workspace_id: `ws_${WS_A}`, name: "Workflow wf_live" }] });
    const replay = await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": system } });
    expect(replay.status).toBe(401);
    const user = jwt({ ...common, jti: randomBytes(12).toString("hex"), user_id: "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890a4", workspace_id: `ws_${WS_A}`, roles: ["admin"], permissions: ["workflows:read"], session_id: "test-session" });
    expect((await fetch(url, { headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": user } })).status).toBe(403);
    const serviceToken = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60, "https://alter.dev/claims/actor_type": "service", tenant_id: `ten_${TENANT}`, workspace_id: `ws_${WS_A}`, roles: ["admin"], permissions: ["workflows:read"] });
    expect((await fetch(url, { headers: { authorization: `Bearer ${serviceToken}` } })).status).toBe(403);
  });

  function jwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid: "agent-feed-key", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(pair.privateKey).toString("base64url")}`;
  }
});
