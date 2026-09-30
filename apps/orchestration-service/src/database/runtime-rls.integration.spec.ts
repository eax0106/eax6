import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createExecutorActivities, PostgresOrchestrationStoreProvider, RedisCacheProvider } from "@alterx/adapters";
import { createExecutorTestHarness } from "@alterx/adapters/testing";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, type CompiledDag } from "@alterx/contracts";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import { APP_GUARD } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlackboardGrpcService } from "../blackboard/blackboard-grpc.service";
import { BlackboardService } from "../blackboard/blackboard.service";
import { MergeHandler } from "../registry/handlers/merge.handler";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { IntegrationWebhookController } from "../trigger-bindings/integration-webhook.controller";
import { PostgresTriggerBindingStore } from "../trigger-bindings/postgres-trigger-binding.store";
import { TriggerBindingService } from "../trigger-bindings/trigger-binding.service";
import { signWebhookRequest } from "../trigger-bindings/webhook-signature";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const tenantA = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const tenantB = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workspaceA = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const workspaceB = "018f4d6e-2b4a-7a3e-8c1a-1234567890d1";
const integrationA = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const integrationB = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const runtimeRole = "orchestration_service";
const runtimePassword = randomBytes(24).toString("hex");
const systemTenant = "00000000-0000-7000-8000-000000000000";

describe.sequential("orchestration runtime RLS", () => {
  let container: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let runtimeStore: PostgresOrchestrationStoreProvider;
  let redis: StartedRedisContainer;
  let cache: RedisCacheProvider;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    redis = await new RedisContainer("redis:7.4.2-alpine").start();
    cache = new RedisCacheProvider({ host: redis.getHost(), port: redis.getPort() });
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: container.getConnectionUri(),
      migrationsFolder,
    });
    await store.withTenant(systemTenant, (tx) =>
      tx.query(`CREATE ROLE ${runtimeRole} LOGIN NOBYPASSRLS PASSWORD '${runtimePassword}'`),
    );
    await store.migrate();

    await store.withTenant(systemTenant, async (tx) => {
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
      await tx.query(`ALTER FUNCTION resolve_webhook_endpoint(text) OWNER TO ${runtimeRole}`);
      await tx.query(
        `INSERT INTO webhook_endpoints
         (id, tenant_id, workspace_id, integration_id, path_token)
       VALUES
         ('wep_a', $1, $2, $3, 'public-path-a'),
         ('wep_b', $4, $5, $6, 'public-path-b')`,
        [tenantA, workspaceA, integrationA, tenantB, workspaceB, integrationB],
      );
      await tx.query(
        `INSERT INTO webhook_endpoint_secrets
         (id, tenant_id, endpoint_id, version, secret_ref, status)
       VALUES
         ('whs_a', $1, 'wep_a', 1, '/alter/test/webhook/a', 'active'),
         ('whs_b', $2, 'wep_b', 1, '/alter/test/webhook/b', 'active')`,
        [tenantA, tenantB],
      );
    });

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: runtimeUrl.toString(),
      migrationsFolder,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cache?.close();
    await redis?.stop();
    await runtimeStore?.close();
    await store?.close();
    await container?.stop();
  }, 60_000);

  it("holds the runtime role to RLS while a narrowly granted resolver finds one public endpoint", async () => {
    const role = await runtimeStore.withTenant(systemTenant, (tx) =>
      tx.query<{ rolbypassrls: boolean }>("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"),
    );
    expect(role.rows).toEqual([{ rolbypassrls: false }]);

    const { own, other } = await runtimeStore.withTenant(tenantA, async (tx) => {
      const own = await tx.query<{ id: string }>("SELECT id FROM webhook_endpoints ORDER BY id");
      const other = await tx.query<{ id: string }>("SELECT id FROM webhook_endpoints WHERE id = 'wep_b'");
      return { own, other };
    });
    expect(own.rows).toEqual([{ id: "wep_a" }]);
    expect(other.rows).toEqual([]);

    const { resolved, unknown } = await runtimeStore.withTenant(systemTenant, async (tx) => {
      const resolved = await tx.query<{ endpoint_id: string; tenant_id: string; secret_ref: string }>(
        "SELECT endpoint_id, tenant_id::text, secret_ref FROM resolve_webhook_endpoint($1)",
        ["public-path-b"],
      );
      const unknown = await tx.query("SELECT * FROM resolve_webhook_endpoint($1)", ["missing-path"]);
      return { resolved, unknown };
    });
    expect(resolved.rows).toEqual([{ endpoint_id: "wep_b", tenant_id: tenantB, secret_ref: "/alter/test/webhook/b" }]);
    expect(unknown.rows).toEqual([]);
  });

  it("completes a real Temporal workflow and persists its node and blackboard through the runtime role", async () => {
    const runId = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
    const service = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      new NodeExecutionLedgerService(runtimeStore),
    );
    const blackboard = new BlackboardGrpcService(new BlackboardService(runtimeStore, cache));
    const dag: CompiledDag = {
      schema_version: "v1", entry_node_keys: ["merge"],
      nodes: [{ key: "merge", type: "Merge", config: {}, metadata: { ui: {} } }],
      edges: [], waves: [{ key: "wave_0", order: 0, node_keys: ["merge"], depends_on: [] }],
    };
    const workflowId = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";
    const versionId = "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890a5";
    await runtimeStore.withTenant(tenantA, async (tx) => {
      await tx.query("INSERT INTO workflows (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, 'Runtime role proof')", [workflowId, tenantA, workspaceA]);
      await tx.query("INSERT INTO workflow_versions (id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, status) VALUES ($1, $2, $3, 1, $4::jsonb, 'v1', 'compiled')", [versionId, tenantA, workflowId, JSON.stringify(dag)]);
      await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, workflow_id, workflow_version_id, status) VALUES ($1, $2, $3, 'workflow', $4, $5, 'running')", [runId, tenantA, workspaceA, workflowId, versionId]);
    });
    const harness = await createExecutorTestHarness("runtime-role-live", createExecutorActivities(service, blackboard));
    try {
      await harness.run("runtime-role-live-workflow", {
        tenantId: `ten_${tenantA}`, runId, compiledDagJson: JSON.stringify(dag),
      });
    } finally {
      await harness.teardown();
    }
    const rows = await runtimeStore.withTenant(tenantA, async (tx) => ({
      run: (await tx.query("SELECT status FROM runs WHERE id = $1", [runId])).rows,
      nodes: (await tx.query("SELECT status FROM node_executions WHERE run_id = $1", [runId])).rows,
      output: (await tx.query("SELECT value_json FROM blackboard_checkpoints WHERE run_id = $1 AND context_key = 'merge'", [runId])).rows,
    }));
    expect(rows).toEqual({ run: [{ status: "completed" }], nodes: [{ status: "succeeded" }], output: [{ value_json: {} }] });
    expect((await runtimeStore.withTenant(tenantB, (tx) => tx.query("SELECT id FROM runs WHERE id = $1", [runId]))).rows).toEqual([]);
  }, 120_000);

  it("accepts a signed public webhook through the real HTTP guard and rejects an unsigned delivery", async () => {
    const signingSecret = randomBytes(32).toString("hex");
    const secrets = createMockMutableSecretsProvider({ secrets: { "/alter/test/webhook/b": signingSecret } });
    const service = new TriggerBindingService(new PostgresTriggerBindingStore(runtimeStore), secrets, { webhookBaseUrl: "http://127.0.0.1" });
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine" }),
      new ActorTokenValidator(
        { issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://identity.test/jwks" },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())),
      ), runtimeStore,
    );
    const module = await Test.createTestingModule({
      controllers: [IntegrationWebhookController],
      providers: [{ provide: TriggerBindingService, useValue: service }, { provide: APP_GUARD, useValue: guard }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/v1/webhooks/integrations/public-path-b`;
    const rawBody = Buffer.from('{"event":"runtime-proof"}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const accepted = await fetch(url, {
      method: "POST", body: rawBody,
      headers: { "content-type": "application/json", [WEBHOOK_TIMESTAMP_HEADER]: timestamp, [WEBHOOK_SIGNATURE_HEADER]: signWebhookRequest(timestamp, rawBody, signingSecret) },
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ endpointId: "wep_b", accepted: true, matchedBindingIds: [] });
    const rejected = await fetch(url, { method: "POST", body: rawBody, headers: { "content-type": "application/json" } });
    expect(rejected.status).toBe(401);
  });
});
