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
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { RunStreamEventService } from "../runs/run-stream-event.service";
import { RunObservabilityService } from "../runs/run-observability.service";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { SES_DELIVERY_ENVIRONMENT } from "../config/ses-delivery-environment";
import { EmailDeliveryFailuresController, SesDeliveryEventsController } from "./ses-delivery-events.controller";
import { SesDeliveryEventsService } from "./ses-delivery-events.service";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const other = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const migrationsFolder = resolve("apps/orchestration-service/drizzle");
const uuid = () => { const id = randomUUID(); return `${id.slice(0, 14)}7${id.slice(15)}`; };

describe.sequential("SES read-back through restricted Postgres and real HTTP guards", () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let store: PostgresOrchestrationStoreProvider;
  let ledger: NodeExecutionLedgerService;
  let service: SesDeliveryEventsService;
  let app: NestFastifyApplication;
  let base: string;
  let key: KeyObject;
  const webhookSecret = randomBytes(32).toString("hex");

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("admin").withPassword(randomBytes(24).toString("hex")).start(),
      new RedisContainer("redis:7.4.2-alpine").start(),
    ]);
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `ses_readback_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });
    ledger = new NodeExecutionLedgerService(store);
    service = new SesDeliveryEventsService(store, new RunStreamEventService(store));
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); key = pair.privateKey;
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "ses-test", alg: "RS256", use: "sig" };
    const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine" }, { fetch: fetchJwks }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://identity.test/jwks" },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())), { fetch: fetchJwks }), store,
    );
    const module = await Test.createTestingModule({ controllers: [SesDeliveryEventsController, EmailDeliveryFailuresController], providers: [
      { provide: SesDeliveryEventsService, useValue: service }, { provide: SES_DELIVERY_ENVIRONMENT, useValue: { webhookSecret } },
      { provide: APP_GUARD, useValue: guard },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  }, 120_000);
  afterAll(async () => { await app?.close(); await store?.close(); await admin?.close(); await Promise.all([postgres?.stop(), redis?.stop()]); });

  async function fixture(messageId: string, accepted = true) {
    const run = `run_${uuid()}`, node = `node_${uuid()}`, id = `sfx_${uuid()}`;
    await store.withTenant(tenant, async tx => {
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,status,created_at,ended_at) VALUES($1,$2,$3,'workflow','completed',now()-interval '3 days',now()-interval '3 days')", [run, tenant, workspace]);
      await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES($1,$2,$3,'send','ToolCall','succeeded')", [node, tenant, run]);
    });
    await ledger.recordSideEffectAttempt({ id, tenantId: `ten_${tenant}`, runId: run, dagNodeId: "send", nodeExecutionId: node, toolName: "email.send" });
    if (accepted) await ledger.completeSideEffect(`ten_${tenant}`, id, undefined, messageId);
    return { run, node, id };
  }
  const post = (messageId: string, type = "Bounce", secret = webhookSecret, tenantId = tenant) => fetch(`${base}/v1/webhooks/ses`, {
    method: "POST", headers: { "content-type": "application/json", "x-alter-ses-secret": secret },
    body: JSON.stringify({ eventType: type, mail: { messageId, tags: { alter_tenant_id: [`ten_${tenantId}`] } }, bounce: { bounceType: "Permanent" } }),
  });
  const read = (id: string) => store.withTenant(tenant, tx => tx.query("SELECT * FROM side_effects WHERE id=$1", [id])).then(r => r.rows[0]!);
  function jwt(payload: Record<string, unknown>) {
    const unsigned = [ { alg: "RS256", kid: "ses-test" }, payload ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
  }
  function feed(system = true, tenantId = tenant, cursor?: string) {
    const now = Math.floor(Date.now() / 1000);
    const machine = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 });
    const actor = jwt({ ...(system ? { principal_type: "system", principal: "system:platform-jobs" } : {
      user_id: `usr_${tenant}`, workspace_id: `ws_${workspace}`, roles: ["admin"], session_id: "fixture",
    }), tenant_id: `ten_${tenantId}`, permissions: ["runs:read"], auth_time: now, jti: uuid(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 });
    return fetch(`${base}/api/v1/email-delivery-failures${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, {
      headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": actor },
    });
  }

  it("uses a non-owner role; confirms delivery once and preserves the accepted message id", async () => {
    const roles = await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const effect = await fixture("delivered");
    expect((await post("delivered", "Delivery")).status).toBe(201);
    const first = await read(effect.id);
    expect(first).toMatchObject({ status: "completed", provider_message_id: "delivered", delivery_failed_at: null });
    expect(first.delivery_confirmed_at).not.toBeNull();
    expect((await post("delivered", "Delivery")).status).toBe(201);
    expect((await read(effect.id)).delivery_confirmed_at).toEqual(first.delivery_confirmed_at);
  });
  it("persists an unconfirmed click for the existing tenant-scoped verification view", async () => {
    const effect = await fixture("visible-click");
    const nodeId = `node_${uuid()}`;
    const executor = new NodeexecService(new NodeHandlerRegistry([{
      nodeType: "ToolCall", execute: async () => ({ output: { confirmation: {
        status: "unconfirmed", reason: "No expected page state declared",
      } } }),
    }]), ledger);
    await executor.executeNode({ tenant_id: `ten_${tenant}`, run_id: effect.run, node_execution_id: nodeId,
      node_key: "click", node_type: "ToolCall", config_json: JSON.stringify({ tool_name: "browser.click", input: {} }),
      inputs_json: "{}", success_criteria: [] });
    const view = new RunObservabilityService(store);
    const result = await view.verificationResults(`ten_${tenant}`, effect.run);
    expect(result.data).toContainEqual(expect.objectContaining({ node_execution_id: nodeId,
      gate_type: "mechanical", verdict: "warn", details: { message: "Unconfirmed: No expected page state declared" } }));
    await expect(view.verificationResults(`ten_${other}`, effect.run)).rejects.toThrow(/not found/);
  });
  it("marks late bounce once; later delivery and executor finalization cannot erase it", async () => {
    const effect = await fixture("late-bounce");
    expect((await post("late-bounce")).status).toBe(201);
    expect((await post("late-bounce")).status).toBe(201);
    expect((await post("late-bounce", "Delivery")).status).toBe(201);
    await ledger.completeSideEffect(`ten_${tenant}`, effect.id, undefined, "replacement");
    expect(await read(effect.id)).toMatchObject({ status: "delivery_failed", provider_message_id: "late-bounce", delivery_failure_reason: "Permanent", delivery_confirmed_at: null });
    const run = await store.withTenant(tenant, tx => tx.query("SELECT status,flags FROM runs WHERE id=$1", [effect.run]));
    expect(run.rows[0]).toEqual({ status: "failed", flags: ["email_delivery_failed"] });
    expect((await new RunStreamEventService(store).listAfter(`ten_${tenant}`, effect.run)).events).toHaveLength(1);
    const result = await feed(); expect(result.status).toBe(200);
    expect((await result.json() as { data: unknown[] }).data).toContainEqual({ id: effect.id, run_id: effect.run, workspace_id: `ws_${workspace}` });
  });
  it("refuses wrong authentication, malformed input and another tenant's provider id", async () => {
    const effect = await fixture("scoped");
    expect((await post("scoped", "Bounce", "wrong")).status).toBe(401);
    expect((await post("scoped", "Open")).status).toBe(400);
    expect((await post("scoped", "Bounce", webhookSecret, other)).status).toBe(503);
    expect((await read(effect.id)).status).toBe("completed");
    expect((await fetch(`${base}/api/v1/email-delivery-failures`)).status).toBe(401);
    expect((await feed(false)).status).toBe(403);
    const foreign = await feed(true, other); expect(foreign.status).toBe(200);
    expect((await foreign.json() as { data: unknown[] }).data).toEqual([]);
  });
  it("retries events that arrive before acceptance commits", async () => {
    const effect = await fixture("early", false);
    expect((await post("early")).status).toBe(503);
    await ledger.completeSideEffect(`ten_${tenant}`, effect.id, undefined, "early");
    expect((await post("early")).status).toBe(201);
    expect((await read(effect.id)).status).toBe("delivery_failed");
  });
  it("flags delivery failure on an already cancelled run without changing its terminal status", async () => {
    const effect = await fixture("cancelled");
    await store.withTenant(tenant, tx => tx.query("UPDATE runs SET status='cancelled' WHERE id=$1", [effect.run]));
    expect((await post("cancelled")).status).toBe(201);
    const run = await store.withTenant(tenant, tx => tx.query("SELECT status,flags FROM runs WHERE id=$1", [effect.run]));
    expect(run.rows[0]).toEqual({ status: "cancelled", flags: ["email_delivery_failed"] });
    expect((await read(effect.id)).status).toBe("delivery_failed");
    expect((await new RunStreamEventService(store).listAfter(`ten_${tenant}`, effect.run)).events).toEqual([]);
  });
  it("rolls back side-effect and run changes when durable event insertion fails, then succeeds on retry", async () => {
    const effect = await fixture("rollback");
    await admin.withTenant(tenant, async tx => {
      await tx.query("CREATE FUNCTION reject_delivery_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture journal failure'; END $$");
      await tx.query("CREATE TRIGGER reject_delivery_event BEFORE INSERT ON run_stream_events FOR EACH ROW EXECUTE FUNCTION reject_delivery_event()");
    });
    try {
      expect((await post("rollback")).status).toBe(500);
      expect((await read(effect.id)).status).toBe("completed");
      const run = await store.withTenant(tenant, tx => tx.query("SELECT status,flags FROM runs WHERE id=$1", [effect.run]));
      expect(run.rows[0]).toEqual({ status: "completed", flags: [] });
    } finally { await admin.withTenant(tenant, tx => tx.query("DROP TRIGGER reject_delivery_event ON run_stream_events; DROP FUNCTION reject_delivery_event()")); }
    expect((await post("rollback")).status).toBe(201);
    expect((await read(effect.id)).status).toBe("delivery_failed");
  });
  it("pages every retained failure without a run-age cutoff", async () => {
    const effect = await fixture("paged");
    await store.withTenant(tenant, tx => tx.query(`INSERT INTO side_effects(id,tenant_id,run_id,dag_node_id,node_execution_id,tool_name,status,delivery_failed_at)
      SELECT 'sfx_page_' || lpad(n::text,3,'0'),$1,$2,'send',$3,'email.send','delivery_failed',now() FROM generate_series(1,101) n`, [tenant, effect.run, effect.node]));
    const ids = new Set<string>(); let cursor: string | undefined;
    do {
      const response = await feed(true, tenant, cursor); expect(response.status).toBe(200);
      const body = await response.json() as { data: { id: string }[]; page: { next_cursor: string | null } };
      for (const row of body.data) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
      cursor = body.page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect([...ids].filter(id => id.startsWith("sfx_page_"))).toHaveLength(101);
  });
});
