import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PostgresOrchestrationStoreProvider, RedisCacheProvider, createExecutorActivities, RunDispatchGrpcController, RUNS_DISPATCH_HANDLER, connectRunsGrpcTransport } from "@alterx/adapters";
import { createExecutorTestHarness, type ExecutorTestHarness } from "@alterx/adapters/testing";
import type { CompiledDag } from "@alterx/contracts";
import { PublicFormTokenCodec } from "@alterx/auth";
import { uuidV7 } from "../trigger-bindings/ids";
import { TriggerRegistryService } from "./trigger-registry.service";
import { TriggerEventDispatchService } from "./trigger-event-dispatch.service";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { RunLauncherService } from "../runs/run-launcher.service";
import { DurableRunQueue } from "../runs/durable-run-queue.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { MergeHandler } from "../registry/handlers/merge.handler";
import { BlackboardService } from "../blackboard/blackboard.service";
import { BlackboardGrpcService } from "../blackboard/blackboard-grpc.service";
import { RunBudgetGate } from "../budgets/run-budget-gate";
import { EngineBudgetService } from "../budgets/budget.service";
import { WorkspaceHoldsService } from "../workspace-holds/workspace-holds.service";

const tenant = uuidV7(), workspace = uuidV7(), ten = `ten_${tenant}`, ws = `ws_${workspace}`, actor = `usr_${uuidV7()}`;
const definition = { title: "Inquiry", fields: [{ name: "email", label: "Email", type: "email", required: true }] };
const dag: CompiledDag = { schema_version: "v1", entry_node_keys: ["receive"], nodes: [{ key: "receive", type: "Merge", config: {}, metadata: { ui: {} } }], edges: [], waves: [{ key: "first", order: 0, node_keys: ["receive"], depends_on: [] }] };
const migrationsFolder = resolve("apps/orchestration-service/drizzle"), key = "39".repeat(32);

interface DriverMessage { ready?: boolean | string; token?: string; event?: unknown; requestId?: number; result?: string; error?: string }
function nextMessage(child: ChildProcess, match: (message: DriverMessage) => boolean): Promise<DriverMessage> {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Native driver message timed out")); }, 30000);
    const receive = (message: DriverMessage) => { if (message.error) { cleanup(); reject(new Error(message.error)); } else if (match(message)) { cleanup(); accept(message); } };
    const exited = () => { cleanup(); reject(new Error("Native driver exited before response")); };
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); };
    child.on("message", receive); child.once("exit", exited);
  });
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.disconnect(); await exit;
}
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

describe.sequential("native hosted form canonical dispatch", () => {
  let postgres: StartedPostgreSqlContainer, redis: StartedRedisContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let temporal: ExecutorTestHarness, cache: RedisCacheProvider, blackboard: BlackboardService, app: NestFastifyApplication;
  let author: TriggerRegistryService, workflow: string, workflowVersion: string, trigger: string, token: string, publicUrl: string;
  let surface: ChildProcess, consumer: ChildProcess, requestId = 0;
  const events: unknown[] = [];
  beforeAll(async () => {
    [postgres, redis] = await Promise.all([new PostgreSqlContainer("postgres:16-alpine").start(), new RedisContainer("redis:7-alpine").start()]);
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.withTenant(tenant, tx => tx.query("CREATE ROLE public_surface LOGIN PASSWORD 'public-fixture-only' NOBYPASSRLS NOSUPERUSER")); await admin.migrate();
    await admin.withTenant(tenant, async tx => { await tx.query("CREATE ROLE form_dispatch LOGIN PASSWORD 'engine-fixture-only' NOBYPASSRLS NOSUPERUSER"); await tx.query("GRANT USAGE ON SCHEMA public TO form_dispatch"); await tx.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO form_dispatch"); });
    const uri = new URL(postgres.getConnectionUri()); uri.username = "form_dispatch"; uri.password = "engine-fixture-only";
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    workflow = (await new WorkflowReadService(store).createWorkflow({ tenantId: ten, workspaceId: ws, name: "Native hosted inquiry" })).id;
    workflowVersion = `wfv_${uuidV7()}`;
    await store.withTenant(tenant, tx => tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,1,$4::jsonb,'v1','promoted')", [workflowVersion, tenant, workflow, JSON.stringify(dag)]));
    author = new TriggerRegistryService(store, undefined, undefined, { codec: new PublicFormTokenCodec(key), baseUrl: "https://forms.example.test" });
    const registered = await author.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, workflowVersionId: workflowVersion, type: "webhook", name: "Inquiry", provider: "alter_public_form", config: { publicForm: definition }, actorId: actor });
    trigger = registered.trigger.id;
    const initial = await author.getPublicForm(ten, trigger, ws);
    await author.setTriggerStatus(ten, trigger, "enabled", { workspaceId: ws, actorId: actor, ifMatch: initial.etag });
    cache = new RedisCacheProvider({ host: redis.getHost(), port: redis.getPort() }); blackboard = new BlackboardService(store, cache);
    const executor = new NodeexecService(new NodeHandlerRegistry([new MergeHandler()]), new NodeExecutionLedgerService(store));
    temporal = await createExecutorTestHarness(`public-form-${uuidV7()}`, createExecutorActivities(executor, new BlackboardGrpcService(blackboard)));
    const budget = new RunBudgetGate(new EngineBudgetService(store), { billableMinor: async () => 0 }, { estimateMinor: async () => 100 });
    const launcher = new RunLauncherService(store, temporal.durable, undefined, undefined, new DurableRunQueue(store), budget, undefined, blackboard);
    const dispatcher = new TriggerEventDispatchService(store, launcher, budget);
    const module = await Test.createTestingModule({ controllers: [RunDispatchGrpcController], providers: [{ provide: RUNS_DISPATCH_HANDLER, useValue: dispatcher }] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    const address = `127.0.0.1:${await freePort()}`, protoPath = resolve("packages/contracts/proto/alter/runs/v1/runs.proto");
    connectRunsGrpcTransport(app, { bindAddress: address, protoPath }); await app.startAllMicroservices();
    consumer = fork(resolve("apps/background-workers/src/canonical-events/public-form-native-driver.ts"), [], { env: { ...process.env, NODE_ENV: "test" }, execArgv: ["--import", require.resolve("tsx")], silent: true });
    const consumerReady = nextMessage(consumer, message => Boolean(message.ready));
    consumer.send({ address, protoPath }); await consumerReady;
    uri.username = "public_surface"; uri.password = "public-fixture-only";
    const claims = { tenantId: ten, triggerId: trigger, triggerVersionId: registered.triggerVersion.id };
    surface = fork(resolve("apps/public-surface/src/testing/public-form-native-driver.ts"), [], { env: { ...process.env, NODE_ENV: "test" }, execArgv: ["--import", require.resolve("tsx")], silent: true });
    surface.on("message", (message: DriverMessage) => { if (message.event) events.push(message.event); });
    const surfaceReady = nextMessage(surface, message => Boolean(message.ready));
    surface.send({ database: uri.href, redis: redis.getConnectionUrl(), migrationsFolder, key, claims });
    const ready = await surfaceReady; publicUrl = String(ready.ready); token = String(ready.token);
  }, 120000);
  afterAll(async () => { await Promise.all([stop(surface), stop(consumer)]); await app?.close(); await temporal?.teardown(); await cache?.close(); await store?.close(); await admin?.close(); await Promise.all([postgres?.stop(), redis?.stop()]); }, 120000);
  const submit = (submissionId = randomUUID()) => fetch(`${publicUrl}/f/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submissionId, turnstileResponse: (() => { const claims = new PublicFormTokenCodec(key).parse(token)!; return createHash("sha256").update(`${claims.tenantId}:${claims.triggerId}:${claims.triggerVersionId}`).digest("hex"); })(), values: { email: "KeepCASE@example.com" } }) });
  async function deliver(event: unknown) { const id = ++requestId, result = nextMessage(consumer, message => message.requestId === id); consumer.send({ requestId: id, event }); return (await result).result; }
  const count = () => store.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS count FROM runs WHERE workflow_id=$1", [workflow]));
  it("runs public HTTP in its own process, drains canonical gRPC into one attributed run and remains idempotent on both retries", async () => {
    const submissionId = randomUUID();
    expect((await submit(submissionId)).status).toBe(202); expect((await submit(submissionId)).status).toBe(202); expect(events).toHaveLength(1);
    expect(await deliver(events[0])).toBe("handled"); expect(await deliver(events[0])).toBe("handled");
    const rows = await store.withTenant(tenant, tx => tx.query("SELECT r.id,r.workflow_version_id,r.status,e.payload,e.source,e.event_type,e.trigger_id,e.trigger_version FROM runs r JOIN events e ON e.tenant_id=r.tenant_id AND e.event_id=r.triggering_event_id WHERE r.workflow_id=$1", [workflow]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ workflow_version_id: workflowVersion, status: "running", payload: { email: "KeepCASE@example.com" }, source: "alter.public-form", event_type: "public_form.submitted", trigger_id: trigger, trigger_version: 1 });
    const runId = String(rows.rows[0]!.id);
    const deadline = Date.now() + 15000;
    while (true) {
      const execution = await store.withTenant(tenant, tx => tx.query("SELECT status FROM node_executions WHERE run_id=$1", [runId]));
      if (execution.rows[0]?.status === "succeeded" && await blackboard.readValue({ tenantId: ten, runId, key: "receive" }) !== undefined) break;
      if (Date.now() >= deadline) throw new Error("Real Temporal receive node did not persist its output");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await blackboard.readValue({ tenantId: ten, runId, key: "receive" })).toEqual({ email: "KeepCASE@example.com" });
  }, 30000);
  it("refuses disabled, held and retired definitions even if an earlier valid event is redelivered", async () => {
    const previous = (await count()).rows[0]!.count;
    expect((await submit()).status).toBe(202); const event = events.at(-1);
    let current = await author.getPublicForm(ten, trigger, ws);
    await author.setTriggerStatus(ten, trigger, "disabled", { workspaceId: ws, actorId: actor, ifMatch: current.etag });
    expect((await submit()).status).toBe(404); expect(await deliver(event)).toBe("handled"); expect((await count()).rows[0]!.count).toBe(previous);
    current = await author.getPublicForm(ten, trigger, ws); await author.setTriggerStatus(ten, trigger, "enabled", { workspaceId: ws, actorId: actor, ifMatch: current.etag });
    const holds = new WorkspaceHoldsService(store); await holds.hold(ten, ws, actor);
    try { expect(await deliver(event)).toBe("handled"); expect((await count()).rows[0]!.count).toBe(previous); } finally { await holds.release(ten, ws); }
    current = await author.getPublicForm(ten, trigger, ws);
    await author.createTriggerVersion({ tenantId: ten, triggerId: trigger, workspaceId: ws, actorId: actor, ifMatch: current.etag, config: { publicForm: { ...definition, title: "Replacement" } } });
    expect(await deliver(event)).toBe("handled"); expect((await count()).rows[0]!.count).toBe(previous); expect((await submit()).status).toBe(404);
  });
  it("rolls back event and run when the real current budget refuses a submission", async () => {
    const budget = new EngineBudgetService(store);
    await budget.create(ten, { workspaceId: ws, workflowId: workflow, kind: "workflow", period: "monthly", amountMinor: 1, mode: "hard", createdBy: actor });
    const codec = new PublicFormTokenCodec(key), setup = await author.getPublicForm(ten, trigger, ws);
    token = setup.publicUrl.split("/f/")[1]!;
    expect(codec.parse(token)?.triggerVersionId).toBe(setup.triggerVersionId);
    expect((await submit()).status).toBe(202);
    const event = events.at(-1) as { detail: { idempotency_key: string } };
    const previous = (await count()).rows[0]!.count;
    expect(await deliver(event)).toBe("pending_redelivery"); expect((await count()).rows[0]!.count).toBe(previous);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT event_id FROM events WHERE idempotency_key=$1", [event.detail.idempotency_key]))).rows).toEqual([]);
  });
});
