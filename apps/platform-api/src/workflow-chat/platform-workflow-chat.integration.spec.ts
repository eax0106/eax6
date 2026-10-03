import Fastify from "fastify";
import { randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PlannerClient, createFetchPlannerHttpClient } from "@alterx/adapters";
import { expect, it } from "vitest";
import { EngineClient, CostLedgerClient } from "../engine";
import { ConnectionRegistryClient } from "../engine/connection-registry-client";
import { engineConfigFromEnvironment } from "../engine/config";
import type { EngineAuthProvider } from "../engine/auth";
import { WorkflowService } from "../workflows/workflow.service";
import { RunService } from "../runs/run.service";
import { CostsService } from "../costs/costs.service";
import { PlatformDb } from "../signup/platform-db";
import { PlannerFacadeService } from "../planner-facade/planner-facade.service";
import { CompilerServiceClient } from "../planner-facade/compiler-client";
import { TenantResidencyRepository } from "../planner-facade/tenant-residency.repository";
import { WorkflowSafeguardsService } from "../planner-facade/workflow-safeguards.service";
import { PlatformWorkflowChatService } from "./platform-workflow-chat.service";

// The engine's always-run signed HTTP test launches this child against its real
// restricted PostgreSQL and compiler server. Only model decisions use a protocol edge.
it.runIf(Boolean(process.env.WORKFLOW_CHAT_NATIVE_BRIDGE))("retains chat context through native planner HTTP and compiler gRPC", async () => {
  const fixture = JSON.parse(process.env.WORKFLOW_CHAT_NATIVE_BRIDGE!) as {
    baseUrl: string; compilerAddress: string; tenant: string; workspace: string; user: string; privateKey: string; registryToken: string;
  };
  const objectives: string[] = [], definitions = [{ key: "one", connector: "github" }, { key: "two", connector: "slack" }, { key: "three", connector: "github" }];
  const edgeErrors: unknown[] = [];
  const skeleton = { version: "1", entry_point: "start", nodes: [{ key: "start", type: "llm", config: {}, depends_on: [] },
    ...definitions.map(({ key, connector }, index) => ({ key, type: "tool", config: { tool_name: "search.web", required_connector: connector }, depends_on: index === 0 ? ["start"] : [definitions[index - 1]!.key] }))] };
  const architecture = { status: "ready", version: "1", topology: "sequential", boundaries: [],
    nodes: [{ source_node_key: "start", role: "direct", execution_kind: "llm", depends_on: [] }, ...skeleton.nodes.filter(node => node.type === "tool").map(node => ({
      source_node_key: node.key, role: "deterministic", execution_kind: "deterministic", source_node_type: "tool", depends_on: node.depends_on,
      config: { tool_name: "search.web" }, capability_role: { source_node_key: node.key, required_capabilities: ["tool.search.web"], eligible_kinds: ["tool"] },
    }))], execution_waves: [{ order: 0, node_keys: ["one"], depends_on_wave_orders: [] }] };
  const bindings = { status: "ready", bindings: definitions.map(({ key, connector }) => ({ source_node_key: key, record_id: `tool-${key}`, version: 1,
    kind: "tool", rationale: "native fixture", score: 1, factors: { reliability: 1 }, required_connector: connector })) };
  const intelligence = Fastify();
  intelligence.post("*", async (request, response) => {
    try {
      expect(request.headers.authorization).toBe("Bearer native-planner-edge");
      const input = request.body as Record<string, unknown>;
      expect(input.tenant_id).toBe(`ten_${fixture.tenant}`); expect(input.workspace_id).toBe(`ws_${fixture.workspace}`);
      let result: unknown;
      if (request.url?.endsWith("/understand")) {
        objectives.push(String(input.objective));
        result = { objective: input.objective, current_situation: null, actors: [], systems_involved: [], constraints: [], required_data: [], risk: "low", missing_information: [], success_criteria: [], context_references: [] };
      } else if (request.url === "/planner/decompose") {
        result = { task_skeleton_json: JSON.stringify(skeleton), ambiguity_detected: objectives.length < 3,
          clarification_questions: objectives.length === 1 ? ["Which day?", "Which channel?"] : objectives.length === 2 ? ["Which timezone?"] : [] };
      } else if (request.url?.endsWith("/prepare-compiler-input")) {
        expect(input.constraints).toMatchObject({ customer_visible: false, contains_pii: false, external_action_approval_required: false, allowed_data_residency: [] });
        result = { status: "ready", architecture, binding_decision: bindings };
      } else throw new Error("Unexpected planner route");
      return result;
    } catch (error) {
      edgeErrors.push(error);
      return response.status(500).send("Native planner assertion failed");
    }
  });
  await intelligence.listen({port:0,host:"127.0.0.1"});
  const schema = `chat_bridge_${randomUUID().replaceAll("-", "_")}`, role = `chat_bridge_${randomUUID().replaceAll("-", "_")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`);
    const migrations = join(__dirname, "../db/migrations");
    for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
      for (const statement of readFileSync(join(migrations, file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(statement);
    }
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Native chat','active')", [fixture.tenant]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,name,status,safeguards) VALUES($1,$2,'Native chat','active',$3::jsonb)", [fixture.workspace, fixture.tenant, JSON.stringify({ contains_pii: false, approve_external_actions: false })]);
    const password = randomUUID(); await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const uri = new URL(process.env.DATABASE_URL!); uri.username = role; uri.password = password; uri.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: uri.href });
    const jwt = (claims: Record<string, unknown>) => { const input = [{ alg: "RS256", kid: "chat-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`; };
    const authorization: EngineAuthProvider = { authorize: async context => {
      const now = Math.floor(Date.now() / 1000);
      return { m2mAccessToken: jwt({ iss: "https://chat.test/", aud: "alter-engine", iat: now, exp: now + 60 }),
        actorToken: jwt({ user_id: context.userId, tenant_id: context.tenantId, workspace_id: context.workspaceId, roles: context.roles,
          permissions: context.permissions, session_id: context.sessionId, auth_time: now, jti: randomUUID(),
          iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }) };
    } };
    const config = engineConfigFromEnvironment({ ENGINE_BASE_URL: fixture.baseUrl, ADS_CORE_BASE_URL: fixture.baseUrl, COST_LEDGER_BASE_URL: fixture.baseUrl,
      AUDIT_SERVICE_BASE_URL: fixture.baseUrl, EVAL_FACADE_TOKEN_REF: "native", DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "native", AUDIT_QUERY_SERVICE_TOKEN_REF: "native",
      ENGINE_M2M_TOKEN_URL: `${fixture.baseUrl}/token`, ENGINE_M2M_AUDIENCE: "alter-engine", ENGINE_M2M_CLIENT_ID: "native", ENGINE_M2M_CLIENT_SECRET_REF: "native" });
    const engine = new EngineClient(config, authorization), costs = new CostLedgerClient(config, authorization);
    const planner = new PlannerFacadeService({ getAccessToken: async () => "native-planner-edge" }, new TenantResidencyRepository(pool),
      new WorkflowSafeguardsService(new PlatformDb(pool), { recordEvent: async () => { throw Error("Builder must not emit a safeguard write"); }, getEvent: async () => { throw Error("Builder must not read an audit event"); } }),
      new PlannerClient({ baseUrl: `http://127.0.0.1:${(intelligence.server.address() as { port: number }).port}` }, createFetchPlannerHttpClient(() => "native-planner-edge")),
      new CompilerServiceClient({ address: fixture.compilerAddress, protoPath: "packages/contracts/proto/alter/compiler/v1/compiler.proto" }));
    const workflows = new WorkflowService(engine), chats = new PlatformWorkflowChatService(engine, planner, workflows, new RunService(engine, costs), new CostsService(costs, engine));
    const actor = { user_id: `usr_${fixture.user}`, tenant_id: `ten_${fixture.tenant}`, workspace_id: `ws_${fixture.workspace}`, roles: ["admin"], permissions: [], session_id: "native-chat", auth_time: Math.floor(Date.now() / 1000) };
    const chat = await chats.create({ type: "workflow_builder", title: "Native builder" }, actor, undefined, "native-create");
    const goal = "Build a weekly report from GitHub and Slack, retaining every original requirement";
    const first = await chats.send(chat.id, { content: goal }, "workflow_builder", actor, undefined, "native-first");
    expect(first.assistantMessage?.content).toMatchObject({ questions: ["Which day?", "Which channel?"] });
    const second = await chats.send(chat.id, { content: "Which day?: Friday\nWhich channel?: reporting" }, "workflow_builder", actor, undefined, "native-second");
    expect(second.assistantMessage?.content).toMatchObject({ questions: ["Which timezone?"] });
    const third = await chats.send(chat.id, { content: "Which timezone?: Asia/Kolkata" }, "workflow_builder", actor, undefined, "native-third");
    expect(third.assistantMessage?.kind).toBe("action");
    expect(third.assistantMessage?.content).toMatchObject({ type: "connections_required", missing_connections: [
      { connector_type: "github", node_keys: ["one", "three"], reason: "missing" }, { connector_type: "slack", node_keys: ["two"], reason: "missing" },
    ] });
    expect((await workflows.versions(chat.linkedWorkflowId!, undefined, "20", actor, undefined)).body.data).toEqual([]);
    const registry = new ConnectionRegistryClient(fixture.baseUrl, async () => fixture.registryToken);
    for (const connector of ["github", "slack"]) {
      const connection = randomUUID();
      await registry.upsert({ tenant_id: fixture.tenant, workspace_id: fixture.workspace, connection_id: connection, connector_type: connector, status: "connected", source_revision: 1,
          secret_ref: `/alter/integrations/${fixture.tenant}/${fixture.workspace}/${connection}` });
    }
    const final = await chats.send(chat.id, { content: "Check connections and continue building from the original goal and answers." }, "workflow_builder", actor, undefined, "native-final");
    const versions = (await workflows.versions(chat.linkedWorkflowId!, undefined, "20", actor, undefined)).body.data;
    expect(versions).toHaveLength(1);
    expect(final.assistantMessage?.content).toMatchObject({ text: "Compiled draft version 1 for Native builder.", workflowId: chat.linkedWorkflowId, versionId: versions[0]!.id, version: 1 });
    expect(objectives).toHaveLength(4);
    expect(objectives.slice(1).every(objective => objective.includes(goal) && objective.includes("Which day?") && objective.includes("Which channel?"))).toBe(true);
    expect(objectives.slice(2).every(objective => objective.includes("Friday") && objective.includes("reporting") && objective.includes("Which timezone?"))).toBe(true);
    expect(objectives[3]).toContain("Asia/Kolkata");
    expect((await chats.messages(chat.id, actor)).at(-1)).toEqual(final.assistantMessage);
    expect(await chats.send(chat.id, { content: "Check connections and continue building from the original goal and answers." }, "workflow_builder", actor, undefined, "native-final")).toEqual(final);
    expect(objectives).toHaveLength(4);
  } catch (error) {
    throw edgeErrors.at(-1) ?? error;
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end();
    await intelligence.close();
  }
}, 120000);
