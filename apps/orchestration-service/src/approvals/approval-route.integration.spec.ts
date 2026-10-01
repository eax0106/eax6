import { createSign, generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  createExecutorActivities,
  PostgresOrchestrationStoreProvider,
  type BlackboardHandlerClient,
} from "@alterx/adapters";
import { createExecutorTestHarness, type ExecutorTestHarness } from "@alterx/adapters/testing";
import {
  ActorTokenValidator,
  M2mValidator,
  RedisReplayStore,
  RedisRespSetClient,
  SessionGatewayGuard,
} from "@alterx/auth";
import { createMockAuditEventHandler } from "@alterx/shared-clients";
import type { NodeType } from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { compileArchitectureToDag } from "../compiler/architecture-dag-builder";
import type { NodeExecutionResult, NodeHandler } from "../registry/handler";
import { HumanApprovalHandler } from "../registry/handlers/human-approval.handler";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { RunStreamEventService } from "../runs/run-stream-event.service";
import { ApprovalPoliciesController } from "./approval-policies.controller";
import { ApprovalPolicyService } from "./approval-policy.service";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";

/**
 * Phase 6.3: the approval route a person actually uses, end to end.
 *
 * A compiled plan with an approval gate before an external action runs on a
 * real Temporal executor and pauses. The decision then arrives the way it does
 * in production: an HTTP POST carrying an M2M token and a platform-api actor
 * token through the real SessionGatewayGuard, into ApprovalsService, which
 * signals the waiting workflow through the production Temporal provider.
 * Only the external action itself is a stand-in, so the test can see whether
 * it ran.
 */

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const APPROVER = "018f4d6e-2b4a-7a3e-8c1a-1234567890a5";
const WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a6";
const TASK_QUEUE = "approval-route";

const sent = new Set<string>();

class SendStandIn implements NodeHandler {
  readonly nodeType: NodeType = "ToolCall";
  async execute(context: { readonly run_id?: string }): Promise<NodeExecutionResult> {
    sent.add(context.run_id ?? "");
    return { output: { sent: true } };
  }
}

function blackboard(): BlackboardHandlerClient {
  const values = new Map<string, string>();
  return {
    async readValue(input) {
      const value = values.get(input.key);
      return value === undefined ? { found: false, value_json: "" } : { found: true, value_json: value };
    },
    async writeValue(input) { values.set(input.key, input.value_json); return {}; },
  };
}

// The synthesizer's output for "send an email" under approve_external_actions:
// an approval boundary before the one external action.
const compiledDag = compileArchitectureToDag({
  tenant_id: `ten_${TENANT_A}`,
  workspace_id: `ws_${WORKSPACE}`,
  workflow_id: "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a6",
  dag_schema_version: "v1",
  architecture: {
    status: "ready",
    version: "1",
    topology: "sequential",
    boundaries: [{ kind: "human_approval", before_node_key: "send", reason: "approve before external actions" }],
    nodes: [
      { source_node_key: "send", role: "deterministic", execution_kind: "deterministic", source_node_type: "tool", depends_on: [], config: {} },
    ],
    execution_waves: [{ order: 0, node_keys: ["send"], depends_on_wave_orders: [] }],
  },
  binding_decision: { status: "ready", bindings: [] },
});

describe.sequential("approval route, end to end", () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let store: PostgresOrchestrationStoreProvider;
  let harness: ExecutorTestHarness;
  let approvals: ApprovalsService;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let privateKey: KeyObject;
  const role = `approval_route_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("admin").withPassword(randomBytes(24).toString("hex")).start(),
      new RedisContainer("redis:7.4.2-alpine").start(),
    ]);
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    await admin.withTenant(TENANT_A, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query("INSERT INTO workflows (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, 'fixture')", [WORKFLOW, TENANT_A, WORKSPACE]);
      await tx.query("INSERT INTO workflow_versions (id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version) VALUES ($1, $2, $3, 1, $4, 'v1')", [`wfv_${WORKFLOW.slice(3)}`, TENANT_A, WORKFLOW, JSON.stringify(compiledDag)]);
    });
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });

    // The executor needs the approval service to persist the pending request,
    // and the approval service needs the executor's server to signal; the
    // requester closes over `approvals`, assigned once the server is up.
    const handlers = new NodeHandlerRegistry([
      new SendStandIn(),
      new HumanApprovalHandler({
        requestApproval: async (request) => {
          const created = await approvals.createPending(request);
          return { approvalId: created.id, expiryAt: created.expiryAt };
        },
      }),
    ]);
    const nodeexec = new NodeexecService(handlers, new NodeExecutionLedgerService(store), new RunStreamEventService(store));
    harness = await createExecutorTestHarness(TASK_QUEUE, createExecutorActivities(nodeexec, blackboard()));
    approvals = new ApprovalsService(store, harness.durable);

    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    const jwk: JsonWebKey = { ...pair.publicKey.export({ format: "jwk" }), kid: "approval-key", alg: "RS256", use: "sig" };
    const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
    const guard = new SessionGatewayGuard(
      new M2mValidator({ auth0Domain: "auth.test", apiAudience: "alter-engine" }, { fetch: fetchJwks }),
      new ActorTokenValidator(
        { issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://identity.test/jwks" },
        new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl())),
        { fetch: fetchJwks },
      ),
      store,
    );
    const module = await Test.createTestingModule({
      controllers: [ApprovalsController, ApprovalPoliciesController],
      providers: [
        { provide: ApprovalsService, useValue: approvals },
        { provide: ApprovalPolicyService, useValue: new ApprovalPolicyService(store, createMockAuditEventHandler()) },
        { provide: APP_GUARD, useValue: guard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness?.teardown();
    await store?.close();
    await admin?.withTenant(TENANT_A, async (tx) => { await tx.query(`DROP OWNED BY ${role}`); await tx.query(`DROP ROLE IF EXISTS ${role}`); });
    await admin?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  }, 60_000);

  beforeEach(() => sent.clear());

  /** Starts a run and waits until it is paused on its approval. */
  async function pausedRun() {
    const runId = `run_${uuidV7()}`;
    await admin.withTenant(TENANT_A, (tx) =>
      tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, status) VALUES ($1, $2, $3, 'workflow', 'running')", [runId, TENANT_A, WORKSPACE]),
    );
    const result = harness.run(runId, { tenantId: `ten_${TENANT_A}`, runId, compiledDagJson: JSON.stringify(compiledDag) });
    result.catch(() => undefined);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = await approvals.list(`ten_${TENANT_A}`, { status: "pending" });
      const approval = page.data.find((row) => row.run_id === runId);
      if (approval !== undefined) return { runId, approval, result };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`run ${runId} never paused on an approval`);
  }

  function decide(approvalId: string, action: "approve" | "reject", tenant = TENANT_A, note?: string) {
    return authorized(`/api/v1/approvals/${approvalId}/actions/${action}`, "POST", tenant, note === undefined ? {} : { note });
  }

  function authorized(path: string, method: string, tenant = TENANT_A, body?: unknown, ifMatch?: string, permissions = ["approvals:decide"]) {
    const now = Math.floor(Date.now() / 1_000);
    const machine = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 });
    const actor = jwt({
      user_id: `usr_${APPROVER}`,
      tenant_id: `ten_${tenant}`,
      workspace_id: `ws_${WORKSPACE}`,
      roles: ["admin"],
      permissions,
      session_id: "session",
      auth_time: now,
      jti: randomBytes(12).toString("hex"),
      iss: "alter-platform-api.identity-broker",
      aud: "alter-engine",
      iat: now,
      exp: now + 300,
    });
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": actor, "content-type": "application/json", ...(ifMatch === undefined ? {} : { "if-match": ifMatch }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("pauses before the external action and resumes it when a person approves over HTTP", async () => {
    const { runId, approval, result } = await pausedRun();
    expect(approval.requested_action).toMatchObject({ kind: "run_node", node_key: "send" });
    expect(sent.has(runId)).toBe(false);

    const response = await decide(approval.id, "approve", TENANT_A, "looks right");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: approval.id, status: "approved", decided_by: APPROVER, decision_note: "looks right" });

    await expect(result).resolves.toBeDefined();
    expect(sent.has(runId)).toBe(true);
    const ledger = await admin.withTenant(TENANT_A, (tx) =>
      tx.query<{ status: string }>("SELECT status FROM node_executions WHERE tenant_id = $1 AND id = $2", [TENANT_A, approval.node_execution_id]),
    );
    expect(ledger.rows[0]?.status).toBe("succeeded");
  }, 120_000);

  it("never runs the external action when a person rejects it", async () => {
    const { runId, approval, result } = await pausedRun();

    const response = await decide(approval.id, "reject");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "rejected" });

    await expect(result).rejects.toThrow();
    expect(sent.has(runId)).toBe(false);
  }, 120_000);

  it("refuses a second decision and another tenant's decision, leaving the run as decided", async () => {
    const { runId, approval, result } = await pausedRun();

    const otherTenant = await decide(approval.id, "approve", TENANT_B);
    expect(otherTenant.status).toBe(404);
    expect(sent.has(runId)).toBe(false);

    expect((await decide(approval.id, "reject")).status).toBe(201);
    const second = await decide(approval.id, "approve");
    expect(second.status).toBe(409);

    await expect(result).rejects.toThrow();
    expect(sent.has(runId)).toBe(false);
  }, 120_000);

  it("serves approval settings through real token guards, requiring current preconditions and the caller's scope", async () => {
    const path = `/api/v1/workflows/${WORKFLOW}/approval-policies`;
    const read = await authorized(path, "GET");
    expect(read.status).toBe(200);
    const { data } = await read.json() as { data: { node_key: string; etag: string; mode: string }[] };
    expect(data).toHaveLength(1);
    expect(data[0]!.mode).toBe("ask");
    const stepPath = `${path}/${data[0]!.node_key}`;
    const body = { mode: "ask", timeout_seconds: 120 };
    expect((await authorized(stepPath, "PUT", TENANT_A, body)).status).toBe(428);
    expect((await authorized(stepPath, "PUT", TENANT_A, body, data[0]!.etag, [])).status).toBe(403);
    expect((await authorized(stepPath, "PUT", TENANT_B, body, data[0]!.etag)).status).toBe(404);
    const saved = await authorized(stepPath, "PUT", TENANT_A, body, data[0]!.etag);
    expect(saved.status).toBe(200);
    const result = await saved.json() as { etag: string; set_by: string };
    expect(result.etag).not.toBe(data[0]!.etag);
    expect(result.set_by).toBe(`usr_${APPROVER}`);
    expect((await authorized(stepPath, "PUT", TENANT_A, body, data[0]!.etag)).status).toBe(412);
  });

  function jwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid: "approval-key", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;
  }
});

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
