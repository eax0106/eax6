import { createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { createExecutorActivities, PostgresOrchestrationStoreProvider, RedisCacheProvider } from "@alterx/adapters";
import { createExecutorTestHarness, type ExecutorTestHarness } from "@alterx/adapters/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompiledDag } from "@alterx/contracts";
import { EventController } from "./event.controller";
import { EventQueryService } from "./event-query.service";
import { EventReplayService, type ReplayActor } from "./event-replay.service";
import { RunLauncherService } from "../runs/run-launcher.service";
import { DurableRunQueue } from "../runs/durable-run-queue.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { MergeHandler } from "../registry/handlers/merge.handler";
import { ToolCallHandler } from "../registry/handlers/toolcall.handler";
import { BlackboardService } from "../blackboard/blackboard.service";
import { BlackboardGrpcService } from "../blackboard/blackboard-grpc.service";
import { RunBudgetGate } from "../budgets/run-budget-gate";
import { EngineBudgetService } from "../budgets/budget.service";
import { WorkspaceHoldsService } from "../workspace-holds/workspace-holds.service";
import { DELETE_ORDER } from "../deletion/deletion.service";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const other = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const uuid = () => { const value = randomUUID(); return `${value.slice(0, 14)}7${value.slice(15)}`; };
const actor: ReplayActor = { tenantId: `ten_${tenant}`, workspaceId: `ws_${workspace}`, userId: `usr_${tenant}` };
const payload = { order: { id: "stored-order", amount: 17 }, customer: "fixture@example.test" };
const dag: CompiledDag = { schema_version: "v1", entry_node_keys: ["receive"],
  nodes: [{ key: "receive", type: "Merge", config: {}, metadata: { ui: {} } },
    { key: "notify", type: "ToolCall", config: { tool_name: "email.send",
      credential_ref: `/alter/test/tenant/ten_${tenant}/integration/test/token`,
      arguments: { to: "fixture@example.test", subject: "Replay fixture", body: "Isolated test" } }, metadata: { ui: {} } }],
  edges: [{ key: "receive-notify", from: "receive", to: "notify", kind: "sequential" }],
  waves: [{ key: "input", order: 0, node_keys: ["receive"], depends_on: [] },
    { key: "action", order: 1, node_keys: ["notify"], depends_on: ["input"] }] };

describe.sequential("D11 stored event replay", () => {
  let postgres: StartedPostgreSqlContainer, redis: StartedRedisContainer;
  let admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider, cache: RedisCacheProvider;
  let temporal: ExecutorTestHarness, app: NestFastifyApplication, base: string, signingKey: KeyObject;
  let launcher: RunLauncherService, replay: EventReplayService, events: EventQueryService, blackboard: BlackboardService, budgets: EngineBudgetService;
  const audit = {
    recordEvent: vi.fn(async () => ({ id: `aud_${uuid()}`, entry_hash: "0".repeat(64) })),
    getEvent: vi.fn(async () => { throw new Error("Unexpected audit read"); }),
  };
  const gateway = { invoke: vi.fn(async () => ({ output_json: JSON.stringify({ messageId: `fixture-${uuid()}` }), audit_id: `aud_${uuid()}` })) };

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("admin").withPassword(randomBytes(24).toString("hex")).start(),
      new RedisContainer("redis:7.4.2-alpine").start(),
    ]);
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `event_replay_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });
    cache = new RedisCacheProvider({ host: redis.getHost(), port: redis.getPort() });
    blackboard = new BlackboardService(store, cache);
    const executor = new NodeexecService(new NodeHandlerRegistry([new MergeHandler(), new ToolCallHandler(gateway)]), new NodeExecutionLedgerService(store));
    temporal = await createExecutorTestHarness(`event-replay-${uuid()}`, createExecutorActivities(executor, new BlackboardGrpcService(blackboard)));
    budgets = new EngineBudgetService(store);
    launcher = new RunLauncherService(store, temporal.durable, undefined, undefined, new DurableRunQueue(store),
      new RunBudgetGate(budgets, { billableMinor: async () => 0 }, { estimateMinor: async () => 100 }), audit);
    replay = new EventReplayService(store, launcher); events = new EventQueryService(store);
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); signingKey = pair.privateKey;
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "replay-test", alg: "RS256", use: "sig" };
    const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
    const guard = new SessionGatewayGuard(new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine" }, { fetch: fetchJwks }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://identity.test/jwks" },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())), { fetch: fetchJwks }), store);
    const module = await Test.createTestingModule({ controllers: [EventController], providers: [
      { provide: EventQueryService, useValue: events }, { provide: EventReplayService, useValue: replay }, { provide: APP_GUARD, useValue: guard } ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  }, 120_000);
  afterAll(async () => { await app?.close(); await temporal?.teardown(); await cache?.close(); await store?.close(); await admin?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]); }, 120_000);

  async function fixture(inputDag = dag) {
    const workflow = `wf_${uuid()}`, version = `wfv_${uuid()}`, trigger = `trg_${uuid()}`, event = `evt_${uuid()}`;
    await store.withTenant(tenant, async tx => {
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name,status,draft_dag) VALUES($1,$2,$3,'Replay test','active',$4::jsonb)",
        [workflow, tenant, workspace, JSON.stringify({ ...dag, nodes: [], waves: [], edges: [], entry_node_keys: [] })]);
      await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,1,$4::jsonb,'v1','promoted')", [version, tenant, workflow, JSON.stringify(inputDag)]);
      await tx.query("INSERT INTO triggers(id,tenant_id,workspace_id,workflow_id,name,type,status) VALUES($1,$2,$3,$4,'Replay trigger','manual','enabled')", [trigger, tenant, workspace, workflow]);
      await tx.query("INSERT INTO trigger_versions(id,tenant_id,trigger_id,version,config) VALUES($1,$2,$3,1,'{}')", [`tgv_${uuid()}`, tenant, trigger]);
      await tx.query("INSERT INTO events(event_id,event_type,schema_version,tenant_id,workspace_id,source,idempotency_key,occurred_at,trigger_id,trigger_version,payload,signature_status) VALUES($1,'test.received','v1',$2,$3,'internal',$1,now(),$4,1,$5::jsonb,'verified')", [event, tenant, workspace, trigger, JSON.stringify(payload)]);
    });
    return { workflow, version, event };
  }
  function jwt(body: Record<string, unknown>) {
    const unsigned = [{ alg: "RS256", kid: "replay-test" }, body].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(signingKey).toString("base64url")}`;
  }
  function headers(context = actor, roles = ["operator"], permissions = ["runs:read", "workflows:write"]) {
    const now = Math.floor(Date.now() / 1000);
    return { "content-type": "application/json", authorization: `Bearer ${jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 })}`,
      "x-alter-actor-token": jwt({ user_id: context.userId, workspace_id: context.workspaceId, tenant_id: context.tenantId, roles, permissions,
        session_id: "fixture", auth_time: now, jti: uuid(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }) };
  }
  const real = (event: string, token: string, key = uuid(), context = actor) => fetch(`${base}/api/v1/events/${event}/replay-for-real`, {
    method: "POST", headers: { ...headers(context), "idempotency-key": key }, body: JSON.stringify({ confirmed: true, confirmationToken: token }) });

  it("Postgres: dry replay uses the stored payload and promoted DAG, counts canonical outside actions, and creates nothing", async () => {
    const roles = await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const item = await fixture(); const calls = gateway.invoke.mock.calls.length, audits = audit.recordEvent.mock.calls.length;
    const result = await replay.preview(actor, item.event);
    expect(result).toMatchObject({ mode: "dry_run", payload, workflowVersionId: item.version,
      trace: [{ key: "receive", type: "Merge", input: payload }, { key: "notify", type: "ToolCall", input: payload }],
      actions: [{ nodeKey: "notify", toolName: "email.send" }] });
    expect(gateway.invoke.mock.calls.length).toBe(calls); expect(audit.recordEvent.mock.calls.length).toBe(audits);
    expect((await launcher.listRuns(actor.tenantId, { workflowId: item.workflow })).data).toEqual([]);
    await expect(replay.preview({ ...actor, tenantId: `ten_${other}` }, item.event)).rejects.toThrow(/not found/);
    await expect(replay.preview({ ...actor, workspaceId: `ws_${uuid()}` }, item.event)).rejects.toThrow(/not found/);
  });

  it("HTTP: authenticated previews and real replay enforce scope, confirmation and the run permission", async () => {
    const item = await fixture(), preview = await replay.preview(actor, item.event);
    expect((await fetch(`${base}/api/v1/events/${item.event}/replay`, { method: "POST" })).status).toBe(401);
    const response = await fetch(`${base}/api/v1/events/${item.event}/replay`, { method: "POST", headers: headers(actor, ["viewer"], ["runs:read"]), body: "{}" });
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ mode: "dry_run", payload });
    expect((await real(item.event, preview.confirmationToken, uuid(), { ...actor, tenantId: `ten_${other}` })).status).toBe(404);
    expect((await real(item.event, preview.confirmationToken, uuid(), { ...actor, userId: `usr_${uuid()}` })).status).toBe(409);
    for (const permissions of [[], ["runs:read"]]) {
      const denied = await fetch(`${base}/api/v1/events/${item.event}/replay-for-real`, { method: "POST", headers: { ...headers(actor, ["operator"], permissions), "idempotency-key": uuid() },
        body: JSON.stringify({ confirmed: true, confirmationToken: preview.confirmationToken }) });
      expect(denied.status).toBe(403);
    }
    for (const body of [{}, { confirmed: false, confirmationToken: preview.confirmationToken }, { confirmed: true, confirmationToken: preview.confirmationToken, payload: { forged: true } }]) {
      const denied = await fetch(`${base}/api/v1/events/${item.event}/replay-for-real`, { method: "POST", headers: { ...headers(), "idempotency-key": uuid() }, body: JSON.stringify(body) });
      expect([400, 409]).toContain(denied.status);
    }
    expect((await launcher.listRuns(actor.tenantId, { workflowId: item.workflow })).data).toEqual([]);
  });

  it("HTTP: a changed stored payload or promoted version invalidates the earlier confirmation", async () => {
    const item = await fixture(), preview = await replay.preview(actor, item.event);
    await store.withTenant(tenant, tx => tx.query("UPDATE events SET payload=$2::jsonb WHERE event_id=$1", [item.event, JSON.stringify({ changed: true })]));
    expect((await real(item.event, preview.confirmationToken)).status).toBe(409);
    const fresh = await replay.preview(actor, item.event);
    await store.withTenant(tenant, tx => tx.query("UPDATE workflow_versions SET compiled_dag=$2::jsonb WHERE id=$1", [item.version, JSON.stringify({ ...dag, nodes: [dag.nodes[0]], waves: [dag.waves[0]], edges: [] })]));
    expect((await real(item.event, fresh.confirmationToken)).status).toBe(409);
  });

  it("Postgres: an unavailable reference payload is refused without substituting input or creating a run", async () => {
    const item = await fixture();
    await store.withTenant(tenant, tx => tx.query("UPDATE events SET payload=NULL, payload_reference='s3://fixture/unavailable' WHERE event_id=$1", [item.event]));
    await expect(replay.preview(actor, item.event)).rejects.toThrow(/no inline stored payload/);
    await expect(replay.replay(actor, item.event, { confirmed: true, confirmationToken: "a".repeat(64) }, uuid())).rejects.toThrow(/no inline stored payload/);
    expect((await launcher.listRuns(actor.tenantId, { workflowId: item.workflow })).data).toEqual([]);
  });

  it("transaction: budget, workspace hold and audit failure leave no replay run or input", async () => {
    const item = await fixture(), preview = await replay.preview(actor, item.event);
    const cap = await budgets.create(actor.tenantId, { workspaceId: actor.workspaceId, workflowId: item.workflow, kind: "run_cap", amountMinor: 50, createdBy: actor.userId });
    const blocked = await real(item.event, preview.confirmationToken);
    expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ error_code: "BUDGET_EXCEEDED", retryable: false });
    await expect(replay.replay(actor, item.event, { confirmed: true, confirmationToken: preview.confirmationToken }, uuid())).rejects.toThrow(/exceeded/);
    await store.withTenant(tenant, tx => tx.query("DELETE FROM budgets WHERE id=$1", [cap.id]));
    const holds = new WorkspaceHoldsService(store); await holds.hold(actor.tenantId, actor.workspaceId, actor.userId);
    await expect(replay.replay(actor, item.event, { confirmed: true, confirmationToken: preview.confirmationToken }, uuid())).rejects.toThrow(/pending deletion/);
    await holds.release(actor.tenantId, actor.workspaceId);
    audit.recordEvent.mockRejectedValueOnce(new Error("fixture audit unavailable"));
    await expect(replay.replay(actor, item.event, { confirmed: true, confirmationToken: preview.confirmationToken }, uuid())).rejects.toThrow(/audit unavailable/);
    expect((await launcher.listRuns(actor.tenantId, { workflowId: item.workflow })).data).toEqual([]);
    const checkpoints = await store.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS count FROM blackboard_checkpoints b JOIN runs r ON r.tenant_id=b.tenant_id AND r.id=b.run_id WHERE r.workflow_id=$1", [item.workflow]));
    expect(checkpoints.rows[0]?.count).toBe(0);
  });

  it("Temporal: concurrent confirmed requests execute one real run with stored input and durable attribution", async () => {
    const item = await fixture(), preview = await replay.preview(actor, item.event), key = uuid(), calls = gateway.invoke.mock.calls.length;
    const responses = await Promise.all([1, 2, 3].map(() => real(item.event, preview.confirmationToken, key)));
    expect(responses.map(response => response.status)).toEqual([201, 201, 201]);
    const bodies = await Promise.all(responses.map(response => response.json())) as { runId: string; replayedFrom: string }[];
    expect(new Set(bodies.map(body => body.runId)).size).toBe(1); const run = bodies[0]!.runId;
    let row;
    for (let attempt = 0; attempt < 200; attempt++) { row = await launcher.getRun(actor.tenantId, run); if (row.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 100)); }
    expect(row).toMatchObject({ status: "completed", replayed_from: item.event, replay_confirmed_by: tenant,
      replay_actions: [{ nodeKey: "notify", toolName: "email.send" }] });
    expect(row!.replay_confirmed_at).toBeTruthy();
    expect(await blackboard.readValue({ tenantId: actor.tenantId, runId: run, key: "receive" })).toEqual(payload);
    expect(gateway.invoke.mock.calls.length).toBe(calls + 1);
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ actor_ref: actor.userId, target_ref: run, action: "event.replay.confirmed" }));
    expect((await real(item.event, preview.confirmationToken, key)).status).toBe(201);
    expect(gateway.invoke.mock.calls.length).toBe(calls + 1);
    const listed = (await events.list(actor.tenantId)).data.filter(event => event["event_id"] === item.event);
    expect(listed).toHaveLength(1); expect(listed[0]?.["run_id"]).toBeNull();
    const fk = await store.withTenant(tenant, tx => tx.query("SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE conname='runs_replay_event_tenant_fk'"));
    expect(fk.rows).toEqual([{ child: "runs", parent: "events" }]); expect(DELETE_ORDER.indexOf("runs")).toBeLessThan(DELETE_ORDER.indexOf("events"));
  }, 120_000);

  it("Temporal: a retry drains the transactionally queued replay after its first dispatch response was interrupted", async () => {
    const item = await fixture(), preview = await replay.preview(actor, item.event), key = uuid(), calls = gateway.invoke.mock.calls.length;
    const dispatch = vi.spyOn(launcher, "startAndTransition").mockRejectedValueOnce(new Error("fixture dispatch response interrupted"));
    try {
      await expect(replay.replay(actor, item.event, { confirmed: true, confirmationToken: preview.confirmationToken }, key)).rejects.toThrow(/interrupted/);
      const pending = await launcher.listRuns(actor.tenantId, { workflowId: item.workflow });
      expect(pending.data).toHaveLength(1); expect(pending.data[0]?.status).toBe("pending");
      const queued = await store.withTenant(tenant, tx => tx.query("SELECT run_id FROM run_dispatch_queue WHERE run_id=$1", [pending.data[0]!.id]));
      expect(queued.rows).toHaveLength(1);
      const resumed = await replay.replay(actor, item.event, { confirmed: true, confirmationToken: preview.confirmationToken }, key);
      expect(resumed.runId).toBe(pending.data[0]!.id);
      let status;
      for (let attempt = 0; attempt < 200; attempt++) { status = (await launcher.getRun(actor.tenantId, resumed.runId)).status;
        if (status === "completed") break; await new Promise(resolve => setTimeout(resolve, 100)); }
      expect(status).toBe("completed"); expect(gateway.invoke.mock.calls.length).toBe(calls + 1);
    } finally { dispatch.mockRestore(); }
  }, 120_000);
});
