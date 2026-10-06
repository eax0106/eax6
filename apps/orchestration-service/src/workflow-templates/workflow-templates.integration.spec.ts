import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { ActorContext } from "@alterx/auth";
import { CompiledDagSchema, ToolCallCompiledConfigSchema, type WorkflowTemplate } from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowChatService } from "../workflow-chat/workflow-chat.service";
import { HttpWorkflowTemplateRegistry, WorkflowTemplateNotFoundError } from "./template-registry.client";
import { WorkflowTemplatesService } from "./workflow-templates.service";

/**
 * D18 instantiation on real PostgreSQL through an ordinary role (row security
 * applies), with the eight reviewed template files served over HTTP in the
 * shape the Capability Registry returns them.
 */
const TEMPLATE_DIR = resolve("apps/intelligence-service/src/capability_registry/templates/v1");
const templates: WorkflowTemplate[] = readdirSync(TEMPLATE_DIR).filter((file) => file.endsWith(".json")).sort().map((file) => {
  const definition = JSON.parse(readFileSync(resolve(TEMPLATE_DIR, file), "utf8")) as Record<string, unknown>;
  return { ...definition, version: 1, content_sha256: "a".repeat(64) } as unknown as WorkflowTemplate;
});
const byId = new Map(templates.map((template) => [template.template_id, template]));

const tenant = uuidV7(), workspace = uuidV7(), otherWorkspace = uuidV7(), user = uuidV7();
const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({ actor_type: "user", tenant_id: `ten_${tenant}`, workspace_id: `ws_${workspace}`,
  user_id: `usr_${user}`, roles: ["admin"], permissions: [], session_id: "session-fixture", jti: "templates-fixture", ...overrides });
const migrationsFolder = resolve("apps/orchestration-service/drizzle");

describe.sequential("D18 template instantiation on restricted PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let service: WorkflowTemplatesService, registryServer: Server;
  const role = `tpl_${randomBytes(5).toString("hex")}`;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    await admin.withTenant(tenant, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD 'templates-fixture-only' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = "templates-fixture-only";
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    registryServer = createServer((request, response) => {
      const match = /^\/internal\/capability-registry\/templates(?:\/([a-z0-9-]+))?$/.exec(request.url ?? "");
      const template = match?.[1] === undefined ? undefined : byId.get(match[1]);
      if (match === null || (match[1] !== undefined && template === undefined)) { response.statusCode = 404; response.end("{}"); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(template ?? templates.map(({ template_id, version, title, summary, requirements }) => ({ template_id, version, title, summary, requirements }))));
    });
    await new Promise<void>((done) => registryServer.listen(0, "127.0.0.1", done));
    const address = registryServer.address() as { port: number };
    const chats = new WorkflowChatService(store, { invoke: async () => { throw new Error("templates never call a model"); } });
    service = new WorkflowTemplatesService(store, new HttpWorkflowTemplateRegistry(`http://127.0.0.1:${address.port}`), chats, "local");
  }, 120_000);

  beforeEach(async () => {
    await admin.withTenant(tenant, async (tx) => {
      for (const table of ["conversation_messages", "conversations", "workflow_versions", "workflows", "connection_registry"]) await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    });
  });

  afterAll(async () => {
    await new Promise((done) => registryServer?.close(done));
    await store?.close(); await admin?.close(); await postgres?.stop();
  });

  async function versions(workflowId: string) {
    return (await store.withTenant(tenant, (tx) => tx.query<{ version: number; compiled_dag: unknown }>(
      "SELECT version, compiled_dag FROM workflow_versions WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY version", [tenant, workflowId]))).rows;
  }
  async function notes(chatId: string) {
    return (await store.withTenant(tenant, (tx) => tx.query<{ role: string; kind: string; content_json: Record<string, unknown> }>(
      "SELECT role, kind, content_json FROM conversation_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY ordinal", [tenant, chatId]))).rows;
  }
  async function connectPostgres(targetWorkspace = workspace) {
    const connection = uuidV7();
    await admin.withTenant(tenant, (tx) => tx.query("INSERT INTO connection_registry(tenant_id,workspace_id,connection_id,connector_type,status,secret_ref,source_revision) VALUES ($1,$2,$3,'postgres','connected',$4,1)",
      [tenant, targetWorkspace, connection, `/alter/integrations/${tenant}/${targetWorkspace}/${connection}`]));
    return connection;
  }

  it("runs through an ordinary role, so row policies apply", async () => {
    const result = await store.withTenant(tenant, (tx) => tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(result.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("lists the eight templates from the registry", async () => {
    expect((await service.list()).map((item) => item.template_id)).toEqual(templates.map((item) => item.template_id));
  });

  it("creates a draft workflow and its chat and compiles the reviewed skeleton for this tenant", async () => {
    const result = await service.instantiate(actor(), "meeting-notes-summary", {});
    expect(result).toMatchObject({ status: "compiled", templateId: "meeting-notes-summary", templateVersion: 1 });
    expect(result.conversation).toMatchObject({ type: "workflow_builder", linkedWorkflowId: result.workflowId, title: byId.get("meeting-notes-summary")!.title });
    const [saved] = await versions(result.workflowId);
    const dag = CompiledDagSchema.parse(saved!.compiled_dag);
    const send = dag.nodes.find((node) => node.key === "send_summary")!;
    expect(send.config["credential_ref"]).toBe(`/alter/local/tenant/ten_${tenant}/integration/email-send/default`);
    expect(dag.nodes.some((node) => node.type === "Gate" && (node.config["verification"] as { protected_node_key?: string } | undefined)?.protected_node_key === "send_summary")).toBe(true);
    const status = (await store.withTenant(tenant, (tx) => tx.query<{ status: string }>("SELECT status FROM workflows WHERE id=$1", [result.workflowId]))).rows[0]!.status;
    expect(status).toBe("draft");
    expect(await notes(result.conversation.id)).toEqual([expect.objectContaining({ role: "system", kind: "workflow", content_json: expect.objectContaining({ templateId: "meeting-notes-summary", versionId: (result as { versionId: string }).versionId }) })]);
  });

  it("asks for a missing connection, then compiles into the same workflow once it is connected", async () => {
    const first = await service.instantiate(actor(), "lead-capture-crm-welcome", {});
    expect(first).toMatchObject({ status: "connections_required", missingConnections: [{ connector_type: "postgres", node_keys: ["save_lead"], reason: "missing" }] });
    expect(await versions(first.workflowId)).toEqual([]);
    expect((await notes(first.conversation.id))[0]).toMatchObject({ role: "system", kind: "action", content_json: { type: "connections_required", templateId: "lead-capture-crm-welcome" } });
    await expect(service.instantiate(actor(), "lead-capture-crm-welcome", { workflowId: first.workflowId })).resolves.toMatchObject({ status: "connections_required" });

    await connectPostgres(otherWorkspace);
    await expect(service.instantiate(actor(), "lead-capture-crm-welcome", { workflowId: first.workflowId })).resolves.toMatchObject({ status: "connections_required" });
    const connection = await connectPostgres();
    const retried = await service.instantiate(actor(), "lead-capture-crm-welcome", { workflowId: first.workflowId });
    expect(retried).toMatchObject({ status: "compiled", workflowId: first.workflowId });
    const dag = CompiledDagSchema.parse((await versions(first.workflowId))[0]!.compiled_dag);
    const save = ToolCallCompiledConfigSchema.parse(dag.nodes.find((node) => node.key === "save_lead")!.config);
    expect(save.credential_ref).toBe(`/alter/integrations/${tenant}/${workspace}/${connection}`);
    expect(save.arguments?.["databaseId"]).toBe(connection);
    await expect(service.instantiate(actor(), "lead-capture-crm-welcome", { workflowId: first.workflowId })).rejects.toMatchObject({ code: "TEMPLATE_ALREADY_COMPILED" });
  });

  it("retries only into a workflow this template created, in the caller's workspace", async () => {
    const lead = await service.instantiate(actor(), "lead-capture-crm-welcome", {});
    await expect(service.instantiate(actor(), "invoice-email-to-sheet", { workflowId: lead.workflowId })).rejects.toMatchObject({ code: "TEMPLATE_WORKFLOW_MISMATCH" });
    await expect(service.instantiate(actor({ workspace_id: `ws_${otherWorkspace}` }), "lead-capture-crm-welcome", { workflowId: lead.workflowId })).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    const plain = `wf_${uuidV7()}`;
    await store.withTenant(tenant, (tx) => tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Plain')", [plain, tenant, workspace]));
    await expect(service.instantiate(actor(), "lead-capture-crm-welcome", { workflowId: plain })).rejects.toMatchObject({ code: "TEMPLATE_WORKFLOW_MISMATCH" });
  });

  it("instantiates every template into a valid compiled draft with nothing left unbound", async () => {
    await connectPostgres();
    for (const template of templates) {
      const result = await service.instantiate(actor(), template.template_id, {});
      expect(result.status, template.template_id).toBe("compiled");
      const [saved] = await versions(result.workflowId);
      const dag = CompiledDagSchema.parse(saved!.compiled_dag);
      expect(JSON.stringify(dag), template.template_id).not.toContain("$alter:");
      for (const node of dag.nodes.filter((item) => item.type === "ToolCall")) {
        expect(ToolCallCompiledConfigSchema.parse(node.config).credential_ref, `${template.template_id}/${node.key}`).toBeDefined();
        expect(dag.edges.some((edge) => edge.to === node.key && edge.kind === "conditional"), `${template.template_id}/${node.key} is verified first`).toBe(true);
      }
    }
    const count = await store.withTenant(tenant, (tx) => tx.query<{ count: number }>("SELECT count(*)::int AS count FROM workflows WHERE tenant_id=$1 AND status='draft'", [tenant]));
    expect(count.rows[0]!.count).toBe(8);
  });

  it("reports an unknown template as not found and creates nothing", async () => {
    await expect(service.instantiate(actor(), "not-a-template", {})).rejects.toBeInstanceOf(WorkflowTemplateNotFoundError);
    const count = await store.withTenant(tenant, (tx) => tx.query<{ count: number }>("SELECT count(*)::int AS count FROM workflows WHERE tenant_id=$1", [tenant]));
    expect(count.rows[0]!.count).toBe(0);
  });
});
