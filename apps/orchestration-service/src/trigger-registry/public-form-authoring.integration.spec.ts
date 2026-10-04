import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createServer, type Server } from "node:http";
import type { CanActivate } from "@nestjs/common";
import { SecurityModule } from "../security.module";
import { identityTenantGatewayEnvironment, orchestrationStore } from "../orchestration-infrastructure.module";
import { TriggerRegistryController } from "./trigger-registry.controller";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  let service: TriggerRegistryService, workflow: string, workflowVersion: string;
  let redis: StartedRedisContainer, app: NestFastifyApplication, baseUrl: string, privateKey: string;
  let jwksServer: Server, guardStore: PostgresOrchestrationStoreProvider;
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
    workflowVersion = `wfv_${uuidV7()}`;
    await store.withTenant(tenant, tx => tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,1,$4::jsonb,'v1','compiled')", [workflowVersion, tenant, workflow, JSON.stringify({ schema_version: "v1", nodes: [{ key: "receive", type: "Merge", config: {}, metadata: { ui: {} } }], edges: [], waves: [{ key: "first", order: 0, node_keys: ["receive"], depends_on: [] }], entry_node_keys: ["receive"] })]));
    redis = await new RedisContainer("redis:7-alpine").start();
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "form-native", alg: "RS256", use: "sig" };
    jwksServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>(resolve => jwksServer.listen(0, "127.0.0.1", resolve));
    const address = jwksServer.address();
    if (address === null || typeof address === "string") throw new Error("Native JWKS listener is unavailable");
    const jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
    // Exercise the production authentication factory with real HTTP JWKS,
    // real Redis replay protection and the ordinary native database role.
    const providers = Reflect.getMetadata("providers", SecurityModule) as { provide: unknown; useFactory?: () => CanActivate }[];
    const guards = providers.filter(provider => provider.provide === APP_GUARD);
    expect(guards).toHaveLength(3);
    let guard: CanActivate;
    try {
      for (const [name, value] of Object.entries({ ALTER_ENV: "local", AUTH0_DOMAIN: "auth.test", AUTH0_API_AUDIENCE: "alter-engine", AUTH0_JWKS_URL: jwksUrl,
        ACTOR_TOKEN_ISSUER: "alter-platform-api.identity-broker", ACTOR_TOKEN_AUDIENCE: "alter-engine", ACTOR_TOKEN_JWKS_URL: jwksUrl,
        REDIS_ENDPOINT: redis.getConnectionUrl(), ORCHESTRATION_DATABASE_AUTHENTICATION: "static", ORCHESTRATION_DATABASE_URL: uri.href,
        AWS_REGION: "ap-south-1", ALTER_ARTIFACTS_BUCKET_PARAM: "/alter/local/orchestration/artifacts-bucket" })) vi.stubEnv(name, value);
      const factory = guards[0]?.useFactory;
      if (!factory) throw new Error("Production authentication factory is not registered");
      guard = factory();
      guardStore = orchestrationStore(identityTenantGatewayEnvironment(process.env));
    } finally { vi.unstubAllEnvs(); }
    const module = await Test.createTestingModule({ controllers: [TriggerRegistryController], providers: [{ provide: TriggerRegistryService, useValue: service }, { provide: APP_GUARD, useValue: guard }] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.listen(0, "127.0.0.1"); baseUrl = await app.getUrl();
  }, 120000);
  afterAll(async () => { await app?.close(); await guardStore?.close(); if (jwksServer) await new Promise<void>((resolve, reject) => jwksServer.close(error => error ? reject(error) : resolve())); await redis?.stop(); await store?.close(); await admin?.close(); await postgres?.stop(); });
  const register = (config = { publicForm: definition }) => service.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, workflowVersionId: workflowVersion, name: "Hosted inquiry", type: "webhook", provider: "alter_public_form", config, actorId: actor });
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
  it("preserves a selected workflow version when a definition edit omits its binding", async () => {
    const version = `wfv_${uuidV7()}`;
    await store.withTenant(tenant, tx => tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,2,$4::jsonb,'v1','compiled')", [version, tenant, workflow, JSON.stringify({ schema_version: "v1", nodes: [], edges: [], waves: [], entry_node_keys: [] })]));
    const registered = await service.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, workflowVersionId: version, name: "Bound form", type: "webhook", provider: "alter_public_form", config: { publicForm: definition }, actorId: actor });
    const initial = await service.getPublicForm(ten, registered.trigger.id, ws);
    expect(initial.workflowVersionId).toBe(version);
    const edited = await service.createTriggerVersion({ tenantId: ten, triggerId: registered.trigger.id, workspaceId: ws, actorId: actor, ifMatch: initial.etag, config: { publicForm: { ...definition, title: "Bound edit" } } });
    expect(edited.workflowVersionId).toBe(version);
    expect((await service.getPublicForm(ten, registered.trigger.id, ws)).workflowVersionId).toBe(version);
    await expect(service.createTriggerVersion({ tenantId: ten, triggerId: registered.trigger.id, workspaceId: ws, actorId: actor, ifMatch: (await service.getPublicForm(ten, registered.trigger.id, ws)).etag, workflowVersionId: `wfv_${uuidV7()}`, config: { publicForm: definition } })).rejects.toThrow("must belong");
  });
  it("relays hosted form operations through the actual platform client with signed caller tokens and the native engine guard", async () => {
    expect((await fetch(`${baseUrl}/api/v1/triggers`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const fixture = { baseUrl, privateKey, tenant: ten, workspace: ws, actor, workflow, workflowVersion };
    await promisify(execFile)(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "apps/platform-api/vitest.config.ts", "apps/platform-api/src/triggers/public-form-native.integration.spec.ts", "--maxWorkers=1"], {
      env: { ...process.env, PUBLIC_FORM_AUTHOR_FIXTURE: JSON.stringify(fixture), AUTH0_DOMAIN: "auth.test", API_AUDIENCE: "alter-engine", SIGNING_KEY_PROVIDER: "mock", MARKETPLACE_SEARCH_CURSOR_SECRET: "native-form-cursor-secret" }, timeout: 90000, maxBuffer: 10 * 1024 * 1024,
    });
  }, 120000);
  it("leaves an unbound hosted draft disabled until a workflow version is selected", async () => {
    const result = await service.registerTrigger({ tenantId: ten, workspaceId: ws, workflowId: workflow, name: "Unbound form", type: "webhook", provider: "alter_public_form", config: { publicForm: definition }, actorId: actor });
    const current = await service.getPublicForm(ten, result.trigger.id, ws);
    await expect(service.setTriggerStatus(ten, result.trigger.id, "enabled", { workspaceId: ws, actorId: actor, ifMatch: current.etag })).rejects.toThrow("Select a workflow version");
    expect((await service.getPublicForm(ten, result.trigger.id, ws)).status).toBe("draft");
  });
  it("removes and reapplies the public-role grants and policies through the paired rollback", async () => {
    const sql = readFileSync(resolve(migrationsFolder, "rollback/0053_drop_public_forms.sql"), "utf8").split("--> statement-breakpoint");
    await admin.withTenant(tenant, async tx => { for (const statement of sql) await tx.query(statement); });
    expect((await admin.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS count FROM pg_policies WHERE policyname LIKE 'public_forms_%'"))).rows).toEqual([{ count: 0 }]);
    await admin.withTenant(tenant, tx => tx.query(readFileSync(resolve(migrationsFolder, "0053_public_forms.sql"), "utf8")));
    expect((await admin.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS count FROM pg_policies WHERE policyname LIKE 'public_forms_%'"))).rows).toEqual([{ count: 2 }]);
  });
});
