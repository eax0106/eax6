import { createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { createExecutorActivities, NodeexecGrpcController, PostgresOrchestrationStoreProvider, ToolGatewayClientError } from "@alterx/adapters";
import { createExecutorTestHarness, type ExecutorTestHarness } from "@alterx/adapters/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClarificationsController, RecoveryClarificationController } from "../clarifications/clarifications.controller";
import { ClarificationsService } from "../clarifications/clarifications.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import { ToolCallHandler } from "../registry/handlers/toolcall.handler";
import { RecoveryDispatchService } from "./recovery-dispatch.service";
import { RecoveryPolicyService } from "./recovery-policy.service";
import { RecoveryTriggerService } from "./recovery-trigger.service";
import { DELETE_ORDER } from "../deletion/deletion.service";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const other = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const uuid = () => { const value = randomUUID(); return `${value.slice(0, 14)}7${value.slice(15)}`; };

describe.sequential("D13 recovery clarification", () => {
  let postgres: StartedPostgreSqlContainer, redis: StartedRedisContainer;
  let admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let service: ClarificationsService, policy: RecoveryPolicyService, executor: NodeexecService;
  let temporal: ExecutorTestHarness | undefined, app: NestFastifyApplication, base: string, key: KeyObject;
  const signal = vi.fn(async (request: Parameters<NonNullable<ExecutorTestHarness>["durable"]["signalWorkflow"]>[0]) => {
    if (temporal) await temporal.durable.signalWorkflow(request);
  });
  const invoke = vi.fn(async (request: { readonly tool_name: string }) => {
    if (request.tool_name === "email.send") throw new ToolGatewayClientError("deadline_exceeded", true);
    return { output_json: JSON.stringify({ rowCount: 0, rows: [] }), audit_id: `aud_${uuid()}` };
  });
  const approvals = { createPending: vi.fn(async () => { throw new Error("D13 must use clarification, never approval"); }) };
  const model = { invoke: vi.fn(async () => ({ output_json: JSON.stringify({ message: { role: "assistant",
    content: JSON.stringify({ explanation: "The durable tool observation requires human clarification.", confidence: 0.95,
      evidence: ["durable node error"] }) }, stop_reason: "end_turn" }), usage_json: "{}", resolved_capability: "ADVANCED:test" })) };

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("admin").withPassword(randomBytes(24).toString("hex")).start(),
      new RedisContainer("redis:7.4.2-alpine").start(),
    ]);
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `recovery_clarification_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });
    service = new ClarificationsService(store, { signalWorkflow: signal });
    const dispatch = new RecoveryDispatchService(model as never, {} as never, {} as never, approvals as never,
      {} as never, { signalWorkflow: signal }, {} as never, {} as never, undefined, undefined, undefined, undefined, service);
    policy = new RecoveryPolicyService(store, model as never, dispatch);
    executor = new NodeexecService(new NodeHandlerRegistry([new ToolCallHandler({ invoke })]),
      new NodeExecutionLedgerService(store), undefined, new RecoveryTriggerService(policy, policy));
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); key = pair.privateKey;
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "recovery-test", alg: "RS256", use: "sig" };
    const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
    const guard = new SessionGatewayGuard(new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine" }, { fetch: fetchJwks }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://identity.test/jwks" },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())), { fetch: fetchJwks }), store);
    const module = await Test.createTestingModule({ controllers: [ClarificationsController, RecoveryClarificationController],
      providers: [{ provide: ClarificationsService, useValue: service }, { provide: APP_GUARD, useValue: guard }] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  }, 120_000);
  afterAll(async () => { await temporal?.teardown(); await app?.close(); await store?.close(); await admin?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]); });

  async function runFixture() {
    const id = `run_${uuid()}`;
    await store.withTenant(tenant, tx => tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,status) VALUES($1,$2,$3,'workflow','running')", [id, tenant, workspace]));
    return id;
  }
  const config = (tool: string) => ({ tool_name: tool, credential_ref: `/alter/test/tenant/ten_${tenant}/integration/test/token`,
    arguments: tool === "email.send" ? { to: "test@example.test", subject: "Test", body: "Fixture" } : { databaseId: "test", statement: "UPDATE missing SET value=1", parameters: [] } });
  async function fail(run: string, tool = "email.send") {
    await expect(executor.executeNode({ tenant_id: `ten_${tenant}`, run_id: run, node_execution_id: `node_${uuid()}`,
      node_key: "action", node_type: "ToolCall", config_json: JSON.stringify(config(tool)), inputs_json: "{}", success_criteria: [] })).rejects.toThrow();
    return question(run);
  }
  async function question(run: string) {
    const page = await service.list(`ten_${tenant}`);
    const row = page.data.find(candidate => candidate.run_id === run);
    expect(row, "Recovery must drive a persisted clarification").toBeDefined();
    return row!;
  }
  function jwt(payload: Record<string, unknown>) {
    const unsigned = [{ alg: "RS256", kid: "recovery-test" }, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
  }
  function headers(tenantId = tenant) {
    const now = Math.floor(Date.now() / 1000);
    return { "content-type": "application/json", authorization: `Bearer ${jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 })}`,
      "x-alter-actor-token": jwt({ user_id: `usr_${tenant}`, workspace_id: `ws_${workspace}`, roles: ["operator"], session_id: "fixture",
        tenant_id: `ten_${tenantId}`, permissions: ["runs:read", "runs:clarifications:answer"], auth_time: now, jti: uuid(),
        iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }) };
  }
  const answer = (run: string, id: string, note: unknown, tenantId = tenant) => fetch(`${base}/api/v1/runs/${run}/clarifications/${id}/answer`,
    { method: "POST", headers: headers(tenantId), body: JSON.stringify({ note }) });

  it.each([["database.update", "target_missing", /redirected.*recreated/], ["email.send", "ambiguous_outcome", /uncertain.*will not retry or swap/]] as const)
    ("Postgres: actual %s failure creates %s clarification and repeated dispatch keeps one question", async (tool, failureClass, wording) => {
      const roles = await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
      expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const run = await runFixture(), row = await fail(run, tool);
      expect(row.question).toMatch(wording); expect(row.conversation_id).toBeNull();
      const recovery = await store.withTenant(tenant, tx => tx.query("SELECT * FROM recovery_actions WHERE run_id=$1", [run]));
      const action = recovery.rows[0]!;
      expect(action).toMatchObject({ failure_class: failureClass, strategy: "ask_user", outcome: "escalated" });
      await policy.selectStrategy({ tenant_id: `ten_${tenant}`, run_id: run, node_execution_id: String(action.node_execution_id),
        failure_class: failureClass, root_cause_estimate_json: JSON.stringify(action.root_cause_estimate) });
      const copies = await Promise.all([1, 2, 3].map(() => service.createRecovery({ tenantId: `ten_${tenant}`, runId: run,
        nodeExecutionId: String(action.node_execution_id), recoveryActionId: String(action.id) })));
      expect(copies.every(copy => copy.id === row.id)).toBe(true);
      expect((await service.list(`ten_${other}`)).data).toEqual([]);
      await expect(service.getById(`ten_${other}`, row.id)).rejects.toThrow(/not found/);
      expect(approvals.createPending).not.toHaveBeenCalled();
    });

  it("HTTP: signed answers are scoped, validated, idempotent and roll back when signalling fails", async () => {
    const run = await runFixture(), row = await fail(run);
    const path = `/api/v1/runs/${run}/clarifications/${row.id}/answer`;
    expect((await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: '{"note":"checked"}' })).status).toBe(401);
    expect((await answer(run, row.id, "checked", other)).status).toBe(404);
    expect((await answer(`run_${uuid()}`, row.id, "checked")).status).toBe(404);
    for (const note of ["", "   ", 4, "x".repeat(10001)]) expect((await answer(run, row.id, note)).status).toBe(400);
    signal.mockRejectedValueOnce(new Error("fixture unavailable"));
    expect((await answer(run, row.id, "Checked external system")).status).toBe(500);
    expect((await service.getById(`ten_${tenant}`, row.id)).status).toBe("open");
    const before = signal.mock.calls.length;
    const results = await Promise.all([1, 2, 3].map(() => answer(run, row.id, "Checked external system")));
    expect(results.map(result => result.status)).toEqual([201, 201, 201]);
    expect(signal.mock.calls).toHaveLength(before + 1);
    const result = results[0]!;
    expect(await result.json()).toMatchObject({ id: row.id, run_id: run, status: "answered", answer: "Checked external system", description: row.question });
    const calls = signal.mock.calls.length;
    expect((await answer(run, row.id, "Checked external system")).status).toBe(201);
    expect(signal.mock.calls).toHaveLength(calls);
    expect((await answer(run, row.id, "Different answer")).status).toBe(409);
    expect(signal.mock.calls.at(-1)?.[0]).toMatchObject({ workflowId: run, signalName: "nodeRetryDecided", payload: { action: "give_up" } });
  });

  it("Postgres: expired questions reject answers and cleanup respects the added relationship", async () => {
    const relationships = await store.withTenant(tenant, tx => tx.query<{ child: string; parent: string }>(
      "SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE conname='clarifications_recovery_tenant_fk'"));
    expect(relationships.rows).toEqual([{ child: "clarifications", parent: "recovery_actions" }]);
    for (const edge of relationships.rows) expect(DELETE_ORDER.indexOf(edge.child as typeof DELETE_ORDER[number]))
      .toBeLessThan(DELETE_ORDER.indexOf(edge.parent as typeof DELETE_ORDER[number]));
    const run = await runFixture(), row = await fail(run);
    await store.withTenant(tenant, tx => tx.query("UPDATE clarifications SET expiry_at=now()-interval '1 second' WHERE id=$1", [row.id]));
    expect((await answer(run, row.id, "late answer")).status).toBe(409);
    await service.list(`ten_${tenant}`);
    expect((await service.getById(`ten_${tenant}`, row.id)).status).toBe("expired");
    await store.withTenant(tenant, tx => tx.query("DELETE FROM recovery_actions WHERE run_id=$1", [run]));
    await expect(service.getById(`ten_${tenant}`, row.id)).rejects.toThrow(/not found/);
  });

  it.each(["database.update", "email.send"])("Temporal: %s parks once, then an answer ends the run without another action", async tool => {
    const run = await runFixture();
    const transport = new NodeexecGrpcController(executor);
    const client = { executeNode: vi.fn(async (request: Parameters<NodeexecService["executeNode"]>[0]) => {
      try { return await transport.executeNode(request); }
      catch (error) { const mapped = (error as { getError(): { message: string } }).getError();
        throw Object.assign(new Error(mapped.message), { details: mapped.message }); }
    }), finalizeRun: executor.finalizeRun.bind(executor), finalizeApprovalNode: executor.finalizeApprovalNode.bind(executor) };
    const blackboard = { readValue: vi.fn(), writeValue: vi.fn() };
    temporal = await createExecutorTestHarness(`clarification-${uuid()}`, createExecutorActivities(client, blackboard));
    try {
    let settled = false;
    const result = temporal.run(run, { tenantId: `ten_${tenant}`, runId: run, nodeRecoveryTimeoutMs: 30_000,
      compiledDagJson: JSON.stringify({ schema_version: "v1", entry_node_keys: ["action"],
        nodes: [{ key: "action", type: "ToolCall", config: config(tool), metadata: { ui: {} } }], edges: [],
        waves: [{ key: "wave", order: 0, node_keys: ["action"], depends_on: [] }] }) }).finally(() => { settled = true; });
    // Observe the real persisted pause; attach the rejection handler before it can settle.
    const observed = result.catch(error => error);
    let row;
    for (let attempt = 0; attempt < 150; attempt++) {
      row = (await service.list(`ten_${tenant}`)).data.find(candidate => candidate.run_id === run);
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(row).toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(settled).toBe(false); expect(client.executeNode).toHaveBeenCalledOnce();
    expect((await answer(run, row!.id, "Reviewed the external target")).status).toBe(201);
    expect(await observed).toBeInstanceOf(Error);
    expect(client.executeNode).toHaveBeenCalledOnce(); expect(blackboard.writeValue).not.toHaveBeenCalled();
    const status = await store.withTenant(tenant, tx => tx.query("SELECT status FROM runs WHERE id=$1", [run]));
    expect(status.rows[0]?.status).toBe("failed");
    } finally {
      await temporal.teardown(); temporal = undefined;
    }
  }, 120_000);
});
