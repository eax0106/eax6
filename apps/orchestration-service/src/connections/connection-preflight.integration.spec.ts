import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider, CompilerServiceClient, CompilerGrpcController, COMPILER_HANDLER, connectCompilerGrpcTransport } from "@alterx/adapters";
import { type CompiledDag } from "@alterx/contracts";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GraphCompilerService } from "../compiler/graph-compiler.service";
import { compileTaskSkeletonToDag } from "../compiler/dag-builder";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { WorkflowReadController } from "../workflow-read/workflow-read.controller";
import { ConnectionRegistryService } from "./connection-registry.service";
import { CompilerConnectionsRequiredError } from "./connection-preflight";

const tenant = "00000000-0000-7000-8000-000000000001";
const otherTenant = "00000000-0000-7000-8000-000000000002";
const workspace = "00000000-0000-7000-8000-000000000003";
const otherWorkspace = "00000000-0000-7000-8000-000000000004";
const workflow = `wf_${tenant}`;
const definitions = [{ key: "one", connector: "github" }, { key: "two", connector: "slack" }, { key: "three", connector: "github" }];
const skeleton = () => ({ version: "1", entry_point: "start", nodes: [{ key: "start", type: "llm" as const, config: {}, depends_on: [] }, ...definitions.map(({ key, connector }, i) => ({ key, type: "tool" as const, config: { tool_name: "search.web", required_connector: connector }, depends_on: i === 0 ? ["start"] : [definitions[i - 1]!.key] }))] });
const batch = { type: "connections_required", missing_connections: [
  { connector_type: "github", node_keys: ["one", "three"], reason: "missing" },
  { connector_type: "slack", node_keys: ["two"], reason: "missing" },
] };

describe.sequential("connection preflight native PostgreSQL and compiler boundaries", () => {
  let postgres: StartedPostgreSqlContainer;
  let admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let compiler: GraphCompilerService, registry: ConnectionRegistryService, reader: WorkflowReadService;
  let app: NestFastifyApplication, client: CompilerServiceClient;
  let compilerAddress: string;
  let dag: CompiledDag;

  beforeAll(async () => {
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `preflight_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'connection fixture')", [workflow, tenant, workspace]);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    compiler = new GraphCompilerService(store); registry = new ConnectionRegistryService(store); reader = new WorkflowReadService(store);
    const module = await Test.createTestingModule({ controllers: [CompilerGrpcController, WorkflowReadController], providers: [
      { provide: COMPILER_HANDLER, useValue: compiler }, { provide: WorkflowReadService, useValue: reader },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", async (request: object) => {
      Object.assign(request, { actorContext: { tenant_id: `ten_${tenant}`, workspace_id: `ws_${workspace}` } });
    });
    const port = await new Promise<number>((done, reject) => {
      const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => {
        const address = server.address(); if (address === null || typeof address === "string") return reject(new Error("No fixture port"));
        server.close(error => error ? reject(error) : done(address.port));
      });
    });
    const protoPath = resolve("packages/contracts/proto/alter/compiler/v1/compiler.proto");
    connectCompilerGrpcTransport(app, { bindAddress: `127.0.0.1:${port}`, protoPath });
    await app.init(); await app.startAllMicroservices(); await app.getHttpAdapter().getInstance().ready();
    compilerAddress = `127.0.0.1:${port}`;
    client = new CompilerServiceClient({ address: compilerAddress, protoPath });
  }, 120_000);
  beforeEach(async () => {
    dag = compileTaskSkeletonToDag(skeleton(), "v1");
    await admin.withTenant(tenant, async tx => {
      await tx.query("DELETE FROM workflow_versions"); await tx.query("TRUNCATE connection_registry");
      await tx.query("UPDATE workflows SET draft_dag=$2::jsonb WHERE id=$1", [workflow, JSON.stringify(dag)]);
    });
  });
  afterAll(async () => { await app?.close(); await store?.close(); await admin?.close(); await postgres?.stop(); });
  const versions = async () => (await store.withTenant(tenant, tx => tx.query("SELECT id FROM workflow_versions"))).rows.length;
  const architectureRequest = () => ({
    tenant_id: `ten_${tenant}`, workspace_id: `ws_${workspace}`, workflow_id: workflow, dag_schema_version: "v1",
    architecture_json: JSON.stringify({ status: "ready", version: "1", topology: "sequential", boundaries: [],
      nodes: [{ source_node_key: "start", role: "direct", execution_kind: "llm", depends_on: [] }, ...skeleton().nodes.filter(node => node.type === "tool").map(node => ({ source_node_key: node.key, role: "deterministic", execution_kind: "deterministic", source_node_type: "tool", depends_on: node.depends_on, config: { tool_name: "search.web" }, capability_role: { source_node_key: node.key, required_capabilities: ["tool.search.web"], eligible_kinds: ["tool"] } }))],
      execution_waves: [{ order: 0, node_keys: ["one"], depends_on_wave_orders: [] }],
    }),
    binding_decision_json: JSON.stringify({ status: "ready", bindings: definitions.map(({ key, connector }) => ({ source_node_key: key, record_id: `tool-${key}`, version: 1, kind: "tool", rationale: "fixture", score: 1, factors: { reliability: 1 }, required_connector: connector })) }),
  });
  const compile = async (path: string) => {
    if (path === "architecture") return JSON.parse((await compiler.compileArchitectureWorkflow(architectureRequest())).compiled_dag_json) as CompiledDag;
    if (path === "skeleton") return JSON.parse((await compiler.compileWorkflow({ tenant_id: `ten_${tenant}`, workflow_id: workflow, dag_schema_version: "v1", task_skeleton_json: JSON.stringify(skeleton()) })).compiled_dag_json) as CompiledDag;
    return (await reader.compileWorkflow(`ten_${tenant}`, workflow)).compiledDag as CompiledDag;
  };
  const connect = async (connector: string, scope = workspace, owner = tenant) => {
    const record = { tenant_id: owner, workspace_id: scope, connection_id: randomUUID(), connector_type: connector, status: "connected" as const, source_revision: 1 };
    const complete = { ...record, secret_ref: `/alter/integrations/${owner}/${scope}/${record.connection_id}` };
    await registry.upsert(complete); return complete;
  };

  it("uses a role with actual row policies and ordinary permissions", async () => {
    const role = await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await connect("github");
    expect((await store.withTenant(otherTenant, tx => tx.query("SELECT * FROM connection_registry"))).rows).toEqual([]);
  });
  it.each(["architecture", "skeleton", "draft"])("returns one complete batch and saves no version via %s", async path => {
    await expect(compile(path)).rejects.toMatchObject({ name: "CompilerConnectionsRequiredError", result: batch });
    expect(await versions()).toBe(0);
  });
  it.each(["architecture", "skeleton", "draft"])("pins connected records and refuses revoked records via %s", async path => {
    const github = await connect("github"), slack = await connect("slack");
    const compiled = await compile(path);
    expect(compiled.nodes.filter(node => definitions.some(value => value.key === node.key)).map(node => node.config["credential_ref"])).toEqual([github.secret_ref, slack.secret_ref, github.secret_ref]);
    expect(await versions()).toBe(1);
    await registry.upsert({ ...github, status: "revoked", source_revision: 2 });
    await expect(compile(path)).rejects.toMatchObject({ result: { missing_connections: [{ connector_type: "github", node_keys: ["one", "three"], reason: "unavailable" }] } });
    expect(await versions()).toBe(1);
  });
  it("ignores records outside the workflow workspace and tenant", async () => {
    await connect("github", otherWorkspace); await connect("slack", otherWorkspace);
    await connect("github", workspace, otherTenant); await connect("slack", workspace, otherTenant);
    await expect(compile("draft")).rejects.toMatchObject({ result: batch }); expect(await versions()).toBe(0);
  });
  it("preserves an explicit account choice and refuses references outside scope", async () => {
    const revoked = await connect("github"), active = await connect("github"); await connect("slack");
    await registry.upsert({ ...revoked, status: "error", source_revision: 2 });
    dag.nodes.find(node => node.key === "one")!.config["credential_ref"] = revoked.secret_ref;
    await reader.updateWorkflow({ tenantId: `ten_${tenant}`, workflowId: workflow, dag });
    await expect(compile("draft")).rejects.toBeInstanceOf(CompilerConnectionsRequiredError);
    dag.nodes.find(node => node.key === "one")!.config["credential_ref"] = active.secret_ref;
    await reader.updateWorkflow({ tenantId: `ten_${tenant}`, workflowId: workflow, dag });
    expect((await compile("draft")).nodes.find(node => node.key === "one")!.config["credential_ref"]).toBe(active.secret_ref);
    dag.nodes.find(node => node.key === "one")!.config["credential_ref"] = `/alter/integrations/${tenant}/${otherWorkspace}/${active.connection_id}`;
    await reader.updateWorkflow({ tenantId: `ten_${tenant}`, workflowId: workflow, dag });
    await expect(compile("draft")).rejects.toThrow("outside its workflow scope"); expect(await versions()).toBe(1);
  });
  it("preserves the named batch over the real compiler gRPC transport", async () => {
    await expect(client.compileArchitectureWorkflow(architectureRequest())).rejects.toMatchObject({ code: "failed_precondition", connectionsRequired: batch });
    expect(await versions()).toBe(0);
  });
  it("passes the actual compiler response through a separately launched platform planner", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "alter-planner-preflight-"));
    const reportPath = resolve(directory, "report.json");
    try {
      await promisify(execFile)(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "apps/platform-api/src/planner-facade/planner-facade.service.spec.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`], {
        env: { ...process.env, CONNECTION_PREFLIGHT_COMPILER_ADDRESS: compilerAddress, CONNECTION_PREFLIGHT_COMPILER_REQUEST: JSON.stringify(architectureRequest()) },
        timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      }).catch((error: unknown) => {
        const output = error as { stdout?: string; stderr?: string };
        let detail = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
        for (const [name, value] of Object.entries(process.env)) {
          if (value && /TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(name)) detail = detail.replaceAll(value, "[redacted]");
        }
        detail = detail.replace(/(?:\u001b\[|\^\[\[)[0-9;]*m/g, "");
        console.error("Native platform planner failure:\n" + detail.split("\n").filter(line => /FAIL|AssertionError|Error:|expected|received|Expected|Received|❯/.test(line)).slice(-24).join("\n"));
        throw error;
      });
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        success: boolean;
        numFailedTests: number;
        numPendingTests: number;
        testResults: { assertionResults: { title: string; status: string }[] }[];
      };
      expect(report.success).toBe(true);
      expect(report.numFailedTests).toBe(0);
      expect(report.numPendingTests).toBe(0);
      const native = report.testResults.flatMap(file => file.assertionResults)
        .filter(test => test.title === "keeps the real compiler batch through the actual platform planner");
      expect(native).toHaveLength(1); expect(native[0]!.status).toBe("passed");
      expect(await versions()).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 120_000);
  it("returns the same batch from the actual draft compile HTTP entry point", async () => {
    const result = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/api/v1/workflows/${workflow}/actions/compile` });
    expect(result.statusCode).toBe(409); expect(result.json()).toEqual(batch); expect(await versions()).toBe(0);
  });
});
