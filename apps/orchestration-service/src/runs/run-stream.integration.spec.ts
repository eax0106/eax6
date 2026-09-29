import { createSign, generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  createExecutorActivities,
  PostgresOrchestrationStoreProvider,
} from "@alterx/adapters";
import { createExecutorTestHarness } from "@alterx/adapters/testing";
import {
  ActorTokenValidator,
  M2mValidator,
  RedisReplayStore,
  RedisRespSetClient,
  SessionGatewayGuard,
} from "@alterx/auth";
import type { BlackboardHandlerClient } from "@alterx/adapters";
import {
  ProblemDetailsSchema,
  type CompiledDag,
  type NodeType,
} from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NodeExecutionResult, NodeHandler } from "../registry/handler";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeExecutionLedgerService } from "./node-execution-ledger.service";
import { RunStreamEventService } from "./run-stream-event.service";
import { RunStreamController } from "./run-stream.controller";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const TENANT_A_ID = `ten_${TENANT_A}`;
const TENANT_B_ID = `ten_${TENANT_B}`;
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const RUN_A = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
const RUN_B = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890b3";
const PROJECT_A = "prj_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";

class EchoHandler implements NodeHandler {
  readonly nodeType: NodeType = "Merge";
  async execute(): Promise<NodeExecutionResult> {
    return { output: { completed: true } };
  }
}

function dag(): CompiledDag {
  return {
    schema_version: "v1",
    entry_node_keys: ["node_merge"],
    nodes: [{ key: "node_merge", type: "Merge", config: {}, metadata: { ui: {} } }],
    edges: [],
    waves: [{ key: "wave_0", order: 0, node_keys: ["node_merge"], depends_on: [] }],
  };
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

interface SseFrame { readonly id?: number; readonly event?: string; readonly data?: unknown; readonly comment?: string }

describe.sequential("EXEC-8 live run SSE", () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let store: PostgresOrchestrationStoreProvider;
  let events: RunStreamEventService;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let privateKey: KeyObject;
  let jwk: JsonWebKey;
  const role = `run_stream_test_${randomBytes(6).toString("hex")}`;
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
    });
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });
    events = new RunStreamEventService(store);

    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "stream-key", alg: "RS256", use: "sig" };
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
      controllers: [RunStreamController],
      providers: [
        { provide: RunStreamEventService, useValue: events },
        { provide: APP_GUARD, useValue: guard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await store?.close();
    await admin?.withTenant(TENANT_A, async (tx) => { await tx.query(`DROP OWNED BY ${role}`); await tx.query(`DROP ROLE IF EXISTS ${role}`); });
    await admin?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  }, 60_000);

  beforeEach(async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await admin.withTenant(tenant, async (tx) => {
        await tx.query("DELETE FROM run_stream_events WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM node_executions WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM runs WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM projects WHERE tenant_id = $1", [tenant]);
        await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, status) VALUES ($1, $2, $3, 'workflow', 'running')", [tenant === TENANT_A ? RUN_A : RUN_B, tenant, WORKSPACE]);
      });
    }
  });

  it("streams real Temporal-driven node transitions in sequence", async () => {
    const ledger = new NodeExecutionLedgerService(store);
    const service = new NodeexecService(new NodeHandlerRegistry([new EchoHandler()]), ledger, events);
    const harness = await createExecutorTestHarness("exec8-sse-real", createExecutorActivities(service, blackboard()));
    try { await harness.run("exec8-sse-real-workflow", { tenantId: TENANT_A_ID, runId: RUN_A, compiledDagJson: JSON.stringify(dag()) }); }
    finally { await harness.teardown(); }
    const connection = await connect(TENANT_A_ID);
    const frames = await connection.readEvents(3);
    connection.close();
    expect(frames.map((frame) => [frame.id, frame.event])).toEqual([
      [1, "run.status"],
      [2, "node.started"],
      [3, "node.completed"],
    ]);
  }, 120_000);

  it("reconnects with Last-Event-ID without duplicate or gap", async () => {
    await appendPair();
    const first = await connect(TENANT_A_ID);
    expect((await first.readEvents(1))[0]?.id).toBe(1);
    first.close();
    const resumed = await connect(TENANT_A_ID, "1");
    const frames = await resumed.readEvents(1);
    resumed.close();
    expect(frames.map((frame) => frame.id)).toEqual([2]);
  });

  it("skips a stored event that breaks the event contract and keeps streaming the ones after it", async () => {
    await admin.withTenant(TENANT_A, async (tx) => {
      await tx.query(
        `INSERT INTO run_stream_events (id, tenant_id, run_id, seq, event, payload) VALUES
           ('rse_invalid_1', $1, $2, 1, 'run.status', '{"status":"running"}'::jsonb),
           ('rse_invalid_2', $1, $2, 2, 'run.status', '{"status":"not-a-status"}'::jsonb),
           ('rse_invalid_3', $1, $2, 3, 'run.status', '{"status":"completed"}'::jsonb)`,
        [TENANT_A, RUN_A],
      );
    });
    const connection = await connect(TENANT_A_ID);
    const frames = await connection.readEvents(2);
    connection.close();
    expect(frames.map((frame) => frame.id)).toEqual([1, 3]);
  });

  it("relays terminal frames only for the matching project run", async () => {
    await admin.withTenant(TENANT_A, async (tx) => {
      await tx.query(
        "INSERT INTO projects (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, $4)",
        [PROJECT_A, TENANT_A, WORKSPACE, "Streaming project"],
      );
      await tx.query(
        "UPDATE runs SET parent_kind = 'project', project_id = $3 WHERE tenant_id = $1 AND id = $2",
        [TENANT_A, RUN_A, PROJECT_A],
      );
    });
    await events.append(TENANT_A_ID, RUN_A, {
      event: "terminal.frame",
      data: { stream: "stdout", data: "build complete\\n" },
    });

    const connection = await connect(
      TENANT_A_ID,
      undefined,
      60,
      `/api/v1/projects/${PROJECT_A}/builds/${RUN_A}/stream`,
    );
    const [frame] = await connection.readEvents(1);
    connection.close();

    expect(frame).toMatchObject({
      id: 1,
      event: "terminal.frame",
      data: { data: { stream: "stdout", data: "build complete\\n" } },
    });
  });

  it("emits heartbeat on idle stream", async () => {
    const connection = await connect(TENANT_A_ID);
    const heartbeat = await connection.readComment(20_000);
    connection.close();
    expect(heartbeat.comment).toBe("keepalive");
  }, 25_000);

  it("terminates stream when real actor JWT expires", async () => {
    const connection = await connect(TENANT_A_ID, undefined, 2);
    await expect(connection.closed(5_000)).resolves.toBe(true);
  }, 10_000);

  it("returns 404 and leaks no events for another tenant's run", async () => {
    await appendPair();
    const response = await authenticatedFetch(TENANT_B_ID, RUN_A);
    expect(response.status).toBe(404);
    const body = ProblemDetailsSchema.parse(await response.json());
    expect(body.error_code).toBe("RUN_NOT_FOUND");
    expect(body.trace_id).toMatch(/^trc_/);
    expect(body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(body)).not.toContain("node.started");
  });

  async function appendPair(): Promise<void> {
    const nodeId = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";
    await events.append(TENANT_A_ID, RUN_A, { event: "node.started", data: { node_execution_id: nodeId, dag_node_key: "node_merge", node_type: "Merge", attempt: 1, started_at: new Date().toISOString() } });
    await events.append(TENANT_A_ID, RUN_A, { event: "node.completed", data: { node_execution_id: nodeId, dag_node_key: "node_merge", node_type: "Merge", attempt: 1, status: "succeeded", ended_at: new Date().toISOString() } });
  }

  async function connect(
    tenantId: string,
    lastEventId?: string,
    expiresInSeconds = 60,
    streamPath?: string,
  ) {
    const abort = new AbortController();
    const response = await authenticatedFetch(tenantId, RUN_A, lastEventId, expiresInSeconds, abort.signal, streamPath);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    void reader.closed.catch(() => undefined);
    let buffer = "";
    async function nextFrame(timeoutMs: number): Promise<SseFrame> {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          return parseFrame(raw);
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const expires = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("SSE frame timeout")), timeoutMs);
        });
        const chunk = await Promise.race([reader.read(), expires]).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
        });
        if (chunk.done) throw new Error("SSE closed before frame");
        buffer += new TextDecoder().decode(chunk.value);
      }
    }
    return {
      async readEvents(count: number) { const result: SseFrame[] = []; while (result.length < count) { const frame = await nextFrame(5_000); if (frame.event) result.push(frame); } return result; },
      async readComment(timeoutMs: number) { while (true) { const frame = await nextFrame(timeoutMs); if (frame.comment) return frame; } },
      async closed(timeoutMs: number) { const result = await Promise.race([reader.read().then((value) => value.done), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]); return result; },
      close() { void reader.cancel().catch(() => undefined); abort.abort(); },
    };
  }

  function authenticatedFetch(
    tenantId: string,
    runId: string,
    lastEventId?: string,
    expiresInSeconds = 60,
    signal?: AbortSignal,
    streamPath = `/api/v1/runs/${runId}/stream`,
  ): Promise<Response> {
    const now = Math.floor(Date.now() / 1_000);
    const machine = jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 });
    const actor = jwt({ user_id: "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890a5", tenant_id: tenantId, workspace_id: `ws_${WORKSPACE}`, roles: ["member"], permissions: ["workflow:read"], session_id: "session", auth_time: now, jti: randomBytes(12).toString("hex"), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + expiresInSeconds });
    return fetch(`${baseUrl}${streamPath}`, {
      headers: { authorization: `Bearer ${machine}`, "x-alter-actor-token": actor, ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  function jwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid: "stream-key", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;
  }
});

function parseFrame(raw: string): SseFrame {
  if (raw.startsWith(":")) return { comment: raw.slice(1).trim() };
  const lines = Object.fromEntries(raw.split("\n").map((line) => { const index = line.indexOf(":"); return [line.slice(0, index), line.slice(index + 1).trim()]; }));
  return {
    id: Number(lines["id"]),
    ...(lines["event"] === undefined ? {} : { event: lines["event"] }),
    ...(lines["data"] === undefined ? {} : { data: JSON.parse(lines["data"]) }),
  };
}
