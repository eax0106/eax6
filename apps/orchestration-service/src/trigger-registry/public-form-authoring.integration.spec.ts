import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PublicFormTokenCodec } from "@alterx/auth";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { TriggerRegistryService } from "./trigger-registry.service";

const tenant = uuidV7(), workspace = uuidV7(), otherWorkspace = uuidV7(), ten = `ten_${tenant}`, ws = `ws_${workspace}`, actor = `usr_${uuidV7()}`;
const definition = { title: "Lead inquiry", fields: [{ name: "email", label: "Email", type: "email", required: true }] };
const migrationsFolder = resolve("apps/orchestration-service/drizzle");
describe.sequential("native public form authoring", () => {
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let service: TriggerRegistryService, workflow: string;
  const codec = new PublicFormTokenCodec("37".repeat(32)), role = `form_author_${randomBytes(4).toString("hex")}`;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.withTenant(tenant, async tx => { await tx.query("CREATE ROLE public_surface LOGIN PASSWORD 'form-fixture-only' NOBYPASSRLS NOSUPERUSER"); });
    await admin.migrate();
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD 'author-fixture-only' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = "author-fixture-only";
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    service = new TriggerRegistryService(store, undefined, undefined, { codec, baseUrl: "https://forms.example.com" });
    workflow = (await new WorkflowReadService(store).createWorkflow({ tenantId: ten, workspaceId: ws, name: "Lead inquiry" })).id;
  }, 120000);
  afterAll(async () => { await store?.close(); await admin?.close(); await postgres?.stop(); });
  const register = (config = { publicForm: definition }) => service.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, name: "Hosted inquiry", type: "webhook", provider: "alter_public_form", config, actorId: actor });
  it("creates only explicitly selected valid forms, returns a bound link and writes an attributed event in the transaction", async () => {
    const result = await register(), setup = await service.getPublicForm(ten, result.trigger.id, ws);
    expect(setup).toMatchObject({ definition, status: "draft", version: 1 });
    expect(codec.parse(setup.publicUrl.split("/f/")[1]!)).toEqual({ tenantId: ten, triggerId: result.trigger.id, triggerVersionId: result.triggerVersion.id });
    const events = await store.withTenant(tenant, tx => tx.query("SELECT event_type,source_account_id,trigger_version FROM events WHERE trigger_id=$1", [result.trigger.id]));
    expect(events.rows).toEqual([{ event_type: "public_form.created", source_account_id: actor, trigger_version: 1 }]);
    await expect(service.getPublicForm(ten, result.trigger.id, `ws_${otherWorkspace}`)).rejects.toThrow("not found");
    await expect(service.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, name: "Own source", type: "webhook", config: { publicForm: definition } })).rejects.toThrow("explicitly selected");
    await expect(register({ publicForm: { ...definition, fields: [] } })).rejects.toThrow("Invalid hosted form");
    const plain = await service.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, name: "Own source", type: "webhook" });
    expect(plain.triggerVersion.config).not.toHaveProperty("publicForm");
  });
  it("pins edits and status changes under row locks, serializes concurrent edits and keeps historical definitions", async () => {
    const result = await register(), initial = await service.getPublicForm(ten, result.trigger.id, ws);
    const edit = { tenantId: ten, triggerId: result.trigger.id, workspaceId: ws, actorId: actor, config: { publicForm: { ...definition, title: "Updated inquiry" } } };
    await expect(service.createTriggerVersion(edit)).rejects.toMatchObject({ status: 428 });
    await expect(service.createTriggerVersion({ ...edit, ifMatch: '"stale"' })).rejects.toMatchObject({ status: 412 });
    await expect(service.createTriggerVersion({ ...edit, workspaceId: `ws_${otherWorkspace}`, ifMatch: initial.etag })).rejects.toThrow("not found");
    const results = await Promise.allSettled([service.createTriggerVersion({ ...edit, ifMatch: initial.etag }), service.createTriggerVersion({ ...edit, ifMatch: initial.etag })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const current = await service.getPublicForm(ten, result.trigger.id, ws);
    expect(current).toMatchObject({ version: 2, definition: { title: "Updated inquiry" } });
    await expect(service.setTriggerStatus(ten, result.trigger.id, "enabled", { workspaceId: ws, actorId: actor })).rejects.toMatchObject({ status: 428 });
    await service.setTriggerStatus(ten, result.trigger.id, "enabled", { workspaceId: ws, actorId: actor, ifMatch: current.etag });
    const enabled = await service.getPublicForm(ten, result.trigger.id, ws);
    await expect(service.setTriggerStatus(ten, result.trigger.id, "disabled", { workspaceId: ws, actorId: actor, ifMatch: current.etag })).rejects.toMatchObject({ status: 412 });
    await service.setTriggerStatus(ten, result.trigger.id, "disabled", { workspaceId: ws, actorId: actor, ifMatch: enabled.etag });
    const versions = await store.withTenant(tenant, tx => tx.query("SELECT version,status,config->'publicForm'->>'title' AS title FROM trigger_versions WHERE trigger_id=$1 ORDER BY version", [result.trigger.id]));
    expect(versions.rows).toEqual([{ version: 1, status: "superseded", title: "Lead inquiry" }, { version: 2, status: "active", title: "Updated inquiry" }]);
  });
  it("rolls back the definition when the actual authoring-event insert fails", async () => {
    const result = await register(), current = await service.getPublicForm(ten, result.trigger.id, ws);
    await admin.withTenant(tenant, async tx => { await tx.query("CREATE FUNCTION reject_form_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='public_form.definition_changed' THEN RAISE EXCEPTION 'fixture authoring event failure'; END IF; RETURN NEW; END $$"); await tx.query("CREATE TRIGGER reject_form_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_form_audit()"); });
    try {
      await expect(service.createTriggerVersion({ tenantId: ten, triggerId: result.trigger.id, workspaceId: ws, actorId: actor, ifMatch: current.etag, config: { publicForm: { ...definition, title: "Must roll back" } } })).rejects.toThrow("fixture authoring event failure");
      expect(await service.getPublicForm(ten, result.trigger.id, ws)).toMatchObject({ version: 1, definition, etag: current.etag });
    } finally { await admin.withTenant(tenant, async tx => { await tx.query("DROP TRIGGER reject_form_audit ON events"); await tx.query("DROP FUNCTION reject_form_audit()"); }); }
  });
  it("removes and reapplies the public-role grants and policies through the paired rollback", async () => {
    const sql = readFileSync(resolve(migrationsFolder, "rollback/0053_drop_public_forms.sql"), "utf8").split("--> statement-breakpoint");
    await admin.withTenant(tenant, async tx => { for (const statement of sql) await tx.query(statement); });
    expect((await admin.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS count FROM pg_policies WHERE policyname LIKE 'public_forms_%'"))).rows).toEqual([{ count: 0 }]);
    await admin.withTenant(tenant, tx => tx.query(readFileSync(resolve(migrationsFolder, "0053_public_forms.sql"), "utf8")));
    expect((await admin.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS count FROM pg_policies WHERE policyname LIKE 'public_forms_%'"))).rows).toEqual([{ count: 2 }]);
  });
});
