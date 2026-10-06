import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer as httpServer, type Server } from "node:http";
import { connect, createServer as tcpServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { expect, it, vi } from "vitest";

import {
  AwsSsmParameterProvider, BlackboardClient, MODELGW_HANDLER, ModelgwGrpcController,
  NodeExecutionClient, PostgresOrchestrationStoreProvider, createExecutorActivities,
  startModelgwGrpcTransport,
} from "@alterx/adapters";
import { createExecutorTestHarness, type ExecutorTestHarness } from "@alterx/adapters/testing";
import { CompiledDagSchema, type ModelgwInvokeRequest } from "@alterx/contracts";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a7";
const WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";
const VERSION = "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890a5";
const CRITERION = "The merged outcome contains the successful gate decision.";

async function freePort(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function waitPort(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Fixture service exited before listening");
    const listening = await new Promise<boolean>((done) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); done(true); });
      socket.once("error", () => { socket.destroy(); done(false); });
    });
    if (listening) return;
    await pause(200);
  }
  throw new Error("Fixture service did not listen");
}

// C101 / L34: the lost response is injected after the real finalize RPC
// returns. Temporal retries its production activity, not a direct check()
// invocation. Only the paid model edge is a local contract fixture.
it("retries a lost finalize response through real engine and verification processes without judging twice", async () => {
  const password = randomBytes(24).toString("hex");
  const internalToken = randomBytes(24).toString("hex");
  const suffix = randomBytes(6).toString("hex");
  const parameter = `/alter/local/finalize-proof/${suffix}/bucket`;
  const address = (port: number) => `127.0.0.1:${port}`;
  const ports: Record<string, number> = {};
  for (const name of ["HTTP", "VERIFY", "MODEL", "CONVERSATION", "COMPILER", "RECOVERY", "RUNS", "REGISTRY", "NODEEXEC", "BLACKBOARD", "DEPLOYCTL", "ARTIFACT_CONTENT"]) ports[name] = await freePort();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims: Record<string, unknown>) => {
    const input = `${encode({ alg: "RS256", kid: "finalize-proof", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  };
  const machineToken = () => {
    const now = Math.floor(Date.now() / 1000);
    return jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 300 });
  };
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  let localstack: StartedTestContainer | undefined;
  let issuer: Server | undefined;
  let admin: PostgresOrchestrationStoreProvider | undefined;
  let runtime: PostgresOrchestrationStoreProvider | undefined;
  let parameters: AwsSsmParameterProvider | undefined;
  let model: INestApplication | undefined;
  let harness: ExecutorTestHarness | undefined;
  let nodeexec: NodeExecutionClient | undefined;
  let blackboard: BlackboardClient | undefined;
  const children: ChildProcess[] = [];
  const calls: ModelgwInvokeRequest[] = [];
  let logs = "";
  const redact = (text: string) => [password, internalToken].reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database reference]");
  const child = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const process = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    process.stdout!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    process.stderr!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    children.push(process);
    return process;
  };
  try {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withPassword(password).start();
    redis = await new RedisContainer("redis:7.4.2-alpine").start();
    localstack = await new GenericContainer("localstack/localstack:4.14.0")
      .withEnvironment({ SERVICES: "ssm" }).withExposedPorts(4566)
      .withWaitStrategy(Wait.forHttp("/_localstack/health", 4566).forStatusCode(200)).start();
    for (const [key, value] of Object.entries({ AWS_ENDPOINT_URL: `http://${localstack.getHost()}:${localstack.getMappedPort(4566)}`, AWS_ACCESS_KEY_ID: "local-proof", AWS_SECRET_ACCESS_KEY: "local-proof", AWS_REGION: "ap-south-1", AWS_SESSION_TOKEN: "", AWS_PROFILE: "" })) vi.stubEnv(key, value);
    parameters = new AwsSsmParameterProvider({ region: "ap-south-1" });
    await parameters.putParameter(parameter, `finalize-proof-${suffix}`);
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    await admin.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE orchestration_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query("GRANT USAGE ON SCHEMA public TO orchestration_service");
      await tx.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orchestration_service");
    });
    const uri = new URL(postgres.getConnectionUri());
    uri.username = "orchestration_service"; uri.password = password;
    runtime = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    const dag = CompiledDagSchema.parse({ schema_version: "v1", entry_node_keys: ["gate"], success_criteria: [CRITERION], nodes: [
      { key: "gate", type: "Gate", config: { conditions: { merge: "true" } }, metadata: { ui: {} } },
      { key: "merge", type: "Merge", config: {}, metadata: { ui: {} } },
    ], edges: [{ key: "gate_merge", from: "gate", to: "merge", kind: "sequential" }], waves: [
      { key: "w0", order: 0, node_keys: ["gate"], depends_on: [] },
      { key: "w1", order: 1, node_keys: ["merge"], depends_on: ["w0"] },
    ] });
    await runtime.withTenant(TENANT, async (tx) => {
      expect((await tx.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await tx.query("INSERT INTO workflows (id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'Finalize replay proof')", [WORKFLOW, TENANT, WORKSPACE]);
      await tx.query("INSERT INTO workflow_versions (id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES ($1,$2,$3,1,$4::jsonb,'v1','promoted')", [VERSION, TENANT, WORKFLOW, JSON.stringify(dag)]);
      await tx.query("INSERT INTO runs (id,tenant_id,workspace_id,parent_kind,workflow_id,workflow_version_id,status) VALUES ($1,$2,$3,'workflow',$4,$5,'running')", [RUN, TENANT, WORKSPACE, WORKFLOW, VERSION]);
    });
    issuer = httpServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url === "/token" ? { access_token: machineToken(), token_type: "Bearer", expires_in: 300 } : { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "finalize-proof", alg: "RS256", use: "sig" }] }));
    });
    await new Promise<void>((done) => issuer!.listen(0, "127.0.0.1", done));
    const issuerUrl = `http://127.0.0.1:${(issuer.address() as { port: number }).port}`;
    model = (await Test.createTestingModule({ controllers: [ModelgwGrpcController], providers: [{ provide: MODELGW_HANDLER, useValue: {
      invoke: async (request: ModelgwInvokeRequest) => {
        calls.push(request);
        const messages = (JSON.parse(request.input_json) as { messages: { content: string }[] }).messages;
        const criterionCall = Object.hasOwn(JSON.parse(messages[1]!.content) as object, "success_criteria");
        const content = request.model_alias === "FAST" ? { injection_detected: false, confidence: 0.99, reason: "structured fixture output" }
          : criterionCall ? { criteria: [{ index: 0, met: true, reason: "gate decision appears in terminal merge" }] }
            : { score: 1, rationale: "terminal merge contains the gate decision" };
        return { output_json: JSON.stringify({ message: { content: JSON.stringify(content) } }), usage_json: "{}", resolved_capability: request.model_alias, cache_hit: false };
      },
    } }] }).compile()).createNestApplication(new FastifyAdapter());
    await startModelgwGrpcTransport(model, { bindAddress: address(ports["MODEL"]!), protoPath: resolve("packages/contracts/proto/alter/modelgw/v1/modelgw.proto") });
    const hash = createHash("sha256").update(internalToken).digest("hex");
    const env: NodeJS.ProcessEnv = { ...process.env,
      NODE_ENV: "development", RUNTIME_MODE: "mock", ALTER_ENV: "local", ALTER_CONFIG_SOURCE: "local-file", INGRESS_SESSION_GATEWAY_CORE_ENABLED: "true", DATABASE_AUTHENTICATION: "static",
      ORCHESTRATION_DATABASE_URL: uri.href, ORCHESTRATION_DATABASE_USER: "orchestration_service", REDIS_ENDPOINT: redis.getConnectionUrl(), ORCHESTRATION_PORT: String(ports["HTTP"]),
      AUTH0_DOMAIN: "auth.test", AUTH0_API_AUDIENCE: "alter-engine", AUTH0_JWKS_URL: `${issuerUrl}/jwks`,
      ACTOR_TOKEN_ISSUER: "alter-platform-api.identity-broker", ACTOR_TOKEN_AUDIENCE: "alter-engine", ACTOR_TOKEN_JWKS_URL: `${issuerUrl}/jwks`,
      AUTH0_M2M_TOKEN_URL: `${issuerUrl}/token`, AUTH0_M2M_AUDIENCE: "alter-engine", AUTH0_M2M_CLIENT_ID: "proof", AUTH0_M2M_CLIENT_SECRET: internalToken,
      TEMPORAL_ADDRESS: "127.0.0.1:7233", TEMPORAL_NAMESPACE: "default", EXECUTOR_TASK_QUEUE: `finalize-proof-${suffix}`, CONVERSATION_LIFECYCLE_TASK_QUEUE: `finalize-proof-${suffix}-conversation`,
      ALTER_ARTIFACTS_BUCKET_PARAM: parameter, MODEL_GATEWAY_ADDRESS: address(ports["MODEL"]!), MODEL_GATEWAY_GRPC_TARGET: address(ports["MODEL"]!), VERIFY_SERVICE_ADDRESS: address(ports["VERIFY"]!),
      TOOL_GATEWAY_ADDRESS: "127.0.0.1:1", SANDBOX_SERVICE_ADDRESS: "127.0.0.1:1", MEMORY_SERVICE_ADDRESS: "127.0.0.1:1", MEMORY_SERVICE_AUTHORIZATION: `Bearer ${internalToken}`, PROVISIONING_SERVICE_ADDRESS: "127.0.0.1:1",
      AUDIT_SERVICE_GRPC_ADDRESS: "127.0.0.1:1", EVAL_SERVICE_GRPC_TARGET: "127.0.0.1:1", DELETION_DATABASE_USER: "orchestration_deletion",
      INTERNAL_SERVICE_TOKEN: internalToken, INTERNAL_SERVICE_TOKEN_SHA256: hash, DELETION_SERVICE_TOKEN_SHA256: hash, DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256: hash, EVAL_FACADE_TOKEN_SHA256: hash, CONNECTION_REGISTRY_SERVICE_TOKEN_SHA256: hash, BILLING_SYNC_SERVICE_TOKEN_SHA256: hash,
      EVENTBRIDGE_BUS_NAME: "alter-local", WHATSAPP_APP_SECRET: internalToken, WHATSAPP_VERIFY_TOKEN: internalToken, WHATSAPP_TENANT_ID: TENANT, WHATSAPP_WORKSPACE_ID: WORKSPACE, WEBHOOK_PUBLIC_BASE_URL: `http://${address(ports["HTTP"]!)}`,
    };
    for (const name of ["CONVERSATION", "COMPILER", "RECOVERY", "RUNS", "REGISTRY", "NODEEXEC", "BLACKBOARD", "DEPLOYCTL", "ARTIFACT_CONTENT"]) env[`${name}_GRPC_BIND_ADDRESS`] = address(ports[name]!);
    delete env.TEMPORAL_API_KEY; delete env.MEMORY_SERVICE_BASE_URL;
    const verification = child("uv", ["run", "--frozen", "python", "-m", "src.grpc_server"], resolve("apps/verification-service"), { ...env, GRPC_BIND_ADDRESS: address(ports["VERIFY"]!) });
    await waitPort(ports["VERIFY"]!, verification);
    const engine = child(process.execPath, [resolve("dist/apps/orchestration-service/main.js")], process.cwd(), env);
    await waitPort(ports["HTTP"]!, engine);
    nodeexec = new NodeExecutionClient({ address: address(ports["NODEEXEC"]!), protoPath: resolve("packages/contracts/proto/alter/nodeexec/v1/nodeexec.proto") });
    blackboard = new BlackboardClient({ address: address(ports["BLACKBOARD"]!), protoPath: resolve("packages/contracts/proto/alter/blackboard/v1/blackboard.proto") });
    const native = createExecutorActivities(nodeexec, blackboard);
    let finalizations = 0;
    harness = await createExecutorTestHarness(`finalize-proof-${suffix}`, { ...native, finalizeRun: async (input) => {
      await native.finalizeRun(input);
      finalizations++;
      if (finalizations === 1) throw new Error("Fixture lost the first successful finalize response");
    } });
    const result = await harness.run(RUN, { tenantId: `ten_${TENANT}`, runId: RUN, compiledDagJson: JSON.stringify(dag) });
    const output = { activeSuccessors: ["merge"], evaluations: { merge: true } };
    expect(result.outputs).toEqual({ gate: output, merge: output });
    expect(finalizations).toBe(2);
    expect(calls.map((request) => request.model_alias)).toEqual(["FAST", "ADVANCED", "ADVANCED"]);
    for (const call of calls) expect(call).toMatchObject({ tenant_id: `ten_${TENANT}`, run_id: RUN });
    const rubricCall = JSON.parse(calls[1]!.input_json) as { messages: { content: string }[] };
    expect(JSON.parse(rubricCall.messages[1]!.content)).toMatchObject({ config: { success_criteria: [CRITERION] } });
    const criterionCall = JSON.parse(calls[2]!.input_json) as { messages: { content: string }[] };
    expect(JSON.parse(criterionCall.messages[1]!.content)).toMatchObject({ success_criteria: [{ index: 0, criterion: CRITERION }], untrusted_node_output: { merge: output } });
    const stored = await runtime.withTenant(TENANT, async (tx) => ({
      runs: (await tx.query("SELECT status FROM runs WHERE id=$1", [RUN])).rows,
      acceptance: (await tx.query("SELECT verdict,reviewer_model,node_execution_id FROM verification_results WHERE run_id=$1 AND gate_type='acceptance'", [RUN])).rows,
      nodes: (await tx.query("SELECT dag_node_id,status FROM node_executions WHERE run_id=$1 ORDER BY dag_node_id", [RUN])).rows,
    }));
    expect(stored).toEqual({ runs: [{ status: "completed" }], acceptance: [{ verdict: "pass", reviewer_model: "ADVANCED", node_execution_id: null }], nodes: [{ dag_node_id: "gate", status: "succeeded" }, { dag_node_id: "merge", status: "succeeded" }] });
    console.log("finalize-replay-process-proof-passed; finalize deliveries=2; acceptance rows=1; FAST calls=1; ADVANCED calls=2");
  } catch (error) {
    console.error(redact(logs).slice(-3000));
    throw error;
  } finally {
    await harness?.teardown(); nodeexec?.close();
    for (const process of children.reverse()) if (process.exitCode === null) process.kill("SIGTERM");
    await pause(1000);
    for (const process of children) if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
    await model?.close(); parameters?.close();
    await runtime?.close(); await admin?.close();
    await redis?.stop(); await postgres?.stop(); await localstack?.stop();
    if (issuer?.listening) await new Promise<void>((done) => issuer!.close(() => done()));
    vi.unstubAllEnvs();
  }
}, 180_000);
