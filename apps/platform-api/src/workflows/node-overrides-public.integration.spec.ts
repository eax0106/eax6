import { randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { FastifyRequest } from "fastify";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { expect, it } from "vitest";
import { NodeOverrideComparisonSchema, type CompiledDag } from "@alterx/contracts";
import { EngineClient, EngineExceptionFilter } from "../engine";
import type { EngineAuthProvider } from "../engine/auth";
import { engineConfigFromEnvironment } from "../engine/config";
import { PlatformDb } from "../signup/platform-db";
import { WorkflowSafeguardsService } from "../planner-facade/workflow-safeguards.service";
import { ETAG_RESOURCE_RESOLVER, ConcurrencyExceptionFilter, EtagResponseInterceptor, IfMatchGuard } from "../concurrency";
import { PgIdempotencyStore, IdempotencyInterceptor, IdempotencyExceptionFilter } from "../idempotency";
import { RbacGuard, RbacExceptionFilter, ParamWorkspaceResolver, defaultWorkspaceResolutionRules, WorkspaceResourceTenantResolver, PlatformDbWorkspaceTenantLookup, type ActorContextType, type RbacRequest } from "../rbac";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { WorkflowExceptionFilter } from "./workflow-exception.filter";
import { WorkflowEtagResolver } from "./workflow-etag.resolver";

// Always launched and checked by the engine's signed native HTTP test. Public
// identity is the controlled edge; RBAC, database and engine tokens are real.
it.runIf(Boolean(process.env.WORKFLOW_CHAT_NATIVE_BRIDGE))("persists manual choices through public RBAC, PostgreSQL idempotency and signed engine HTTP", async () => {
  const fixture = JSON.parse(process.env.WORKFLOW_CHAT_NATIVE_BRIDGE!) as { baseUrl: string; tenant: string; workspace: string; user: string; privateKey: string; overrideWorkflowId: string };
  const schema = `override_${randomUUID().replaceAll("-", "_")}`, role = `override_${randomUUID().replaceAll("-", "_")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  let pool: pg.Pool | undefined, app: NestFastifyApplication | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of readdirSync(join(__dirname, "../db/migrations")).filter(name => name.endsWith(".sql")).sort()) {
      for (const sql of readFileSync(join(__dirname, "../db/migrations", file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(sql);
    }
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Native overrides','active')", [fixture.tenant]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,name,status,safeguards) VALUES($1,$2,'Native overrides','active',$3::jsonb)", [fixture.workspace, fixture.tenant, JSON.stringify({ contains_pii: false, approve_external_actions: false })]);
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const uri = new URL(process.env.DATABASE_URL!); uri.username = role; uri.password = password; uri.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: uri.href });
    const identity = (await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    expect(identity).toEqual({ rolsuper: false, rolbypassrls: false });
    const jwt = (claims: Record<string, unknown>) => { const value = [{ alg: "RS256", kid: "chat-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${value}.${sign("RSA-SHA256", Buffer.from(value), fixture.privateKey).toString("base64url")}`; };
    const auth: EngineAuthProvider = { authorize: async context => {
      const now = Math.floor(Date.now() / 1000);
      return { m2mAccessToken: jwt({ iss: "https://chat.test/", aud: "alter-engine", iat: now, exp: now + 60 }), actorToken: jwt({ user_id: context.userId.startsWith("usr_") ? context.userId : `usr_${context.userId}`, tenant_id: context.tenantId.startsWith("ten_") ? context.tenantId : `ten_${context.tenantId}`, workspace_id: context.workspaceId.startsWith("ws_") ? context.workspaceId : `ws_${context.workspaceId}`, roles: context.roles, permissions: context.permissions, session_id: context.sessionId, auth_time: now, jti: randomUUID(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }) };
    } };
    const config = engineConfigFromEnvironment({ ENGINE_BASE_URL: fixture.baseUrl, ADS_CORE_BASE_URL: fixture.baseUrl, COST_LEDGER_BASE_URL: fixture.baseUrl, AUDIT_SERVICE_BASE_URL: fixture.baseUrl, EVAL_FACADE_TOKEN_REF: "native", DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "native", AUDIT_QUERY_SERVICE_TOKEN_REF: "native", ENGINE_M2M_TOKEN_URL: `${fixture.baseUrl}/token`, ENGINE_M2M_AUDIENCE: "alter-engine", ENGINE_M2M_CLIENT_ID: "native", ENGINE_M2M_CLIENT_SECRET_REF: "native" });
    const engine = new EngineClient(config, auth), db = new PlatformDb(pool);
    const safeguards = new WorkflowSafeguardsService(db, { recordEvent: async () => { throw Error("No safeguard write expected"); }, getEvent: async () => { throw Error("No audit read expected"); } });
    const module = await Test.createTestingModule({ controllers: [WorkflowController], providers: [
      { provide: WorkflowService, useValue: new WorkflowService(engine, safeguards) }, WorkflowEtagResolver, WorkflowExceptionFilter,
      IdempotencyInterceptor, IdempotencyExceptionFilter, IfMatchGuard, EtagResponseInterceptor, ConcurrencyExceptionFilter,
      { provide: ETAG_RESOURCE_RESOLVER, useExisting: WorkflowEtagResolver }, { provide: PgIdempotencyStore, useValue: new PgIdempotencyStore(pool, 60000) },
      { provide: APP_FILTER, useClass: EngineExceptionFilter }, { provide: APP_FILTER, useClass: RbacExceptionFilter },
      { provide: APP_GUARD, useValue: new RbacGuard(new Reflector(), new WorkspaceResourceTenantResolver(new PlatformDbWorkspaceTenantLookup(db)), new ParamWorkspaceResolver(defaultWorkspaceResolutionRules({ engineClient: engine, db }))) },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      if (typeof request.headers["x-test-actor"] === "string") (request as RbacRequest).actorContext = JSON.parse(request.headers["x-test-actor"]) as ActorContextType;
      done();
    });
    await app.listen(0, "127.0.0.1");
    const actor: ActorContextType = { user_id: fixture.user, tenant_id: fixture.tenant, workspace_id: fixture.workspace, roles: ["editor"], permissions: [], session_id: "native-overrides", workspaceRoles: [{ workspaceId: fixture.workspace, role: "editor" }] };
    const url = `/api/v1/workflows/${fixture.overrideWorkflowId}`;
    const publicHttp = async (path: string, options: { method?: "GET" | "POST" | "PATCH"; headers: Record<string,string>; body?: string }) => {
      const response = await app!.inject({method:options.method ?? "GET",url:path,headers:options.headers,...(options.body === undefined ? {} : {payload:options.body})});
      return {status:response.statusCode,headers:new Headers(response.headers as Record<string,string>),json:async () => response.json()};
    };
    const headers = (context = actor, key = randomUUID()) => ({ "content-type": "application/json", "x-test-actor": JSON.stringify(context), "idempotency-key": key });
    const detail = await publicHttp(url, { headers: headers() }); expect(detail.status, JSON.stringify(await detail.json())).toBe(200);
    const dag = (await detail.json() as { dag: CompiledDag }).dag;
    const comparison = { nodeKey: "work", choice: { kind: "model", value: "STANDARD" }, dag };
    expect((await publicHttp(`${url}/node-overrides`, { headers: headers() }).then(result => result.json()))).toEqual({ can_edit: true });
    const viewer = { ...actor, roles: ["viewer"], workspaceRoles: [{ workspaceId: actor.workspace_id!, role: "viewer" as const }] };
    expect((await publicHttp(`${url}/node-overrides`, { headers: headers(viewer) }).then(result => result.json()))).toEqual({ can_edit: false });
    expect((await publicHttp(`${url}/node-overrides/compare`, { method: "POST", headers: headers(viewer), body: JSON.stringify(comparison) })).status).toBe(403);
    const elsewhere = { ...actor, workspaceRoles: [{ workspaceId: `ws_${randomUUID()}`, role: "editor" as const }] };
    expect((await publicHttp(`${url}/node-overrides/compare`, { method: "POST", headers: headers(elsewhere), body: JSON.stringify(comparison) })).status).toBe(403);
    const key = randomUUID(), compareHeaders = headers(actor, key);
    const responses = await Promise.all([1, 2].map(() => publicHttp(`${url}/node-overrides/compare`, { method: "POST", headers: compareHeaders, body: JSON.stringify(comparison) })));
    expect(responses.map(result => result.status)).toEqual([200, 200]);
    const first = NodeOverrideComparisonSchema.parse(await responses[0]!.json());
    expect(await responses[1]!.json()).toEqual(first);
    expect(first.original.choice).toEqual({ kind: "model", value: "FAST" });
    expect(first.original.selection?.binding.rationale).toBe("Recorded native fit");
    expect(first.choice.value).toBe("STANDARD"); expect(first.validation.valid).toBe(true);
    expect((await db.withTenant(actor.tenant_id, client => client.query("SELECT count(*)::int AS count FROM idempotency_keys WHERE idempotency_key=$1", [key]))).rows[0]).toEqual({ count: 1 });
    dag.nodes[0]!.config = { ...dag.nodes[0]!.config, model_alias: "STANDARD", manual_model_override: true };
    const save = await publicHttp(url, { method: "PATCH", headers: { ...headers(), "if-match": detail.headers.get("etag")! }, body: JSON.stringify({ dag }) });
    expect(save.status).toBe(200);
    const saved = await publicHttp(url, { headers: headers() }).then(result => result.json()) as { dag: CompiledDag };
    expect(saved.dag.nodes[0]!.config.model_alias).toBe("STANDARD");
    expect(saved.dag.nodes[0]!.metadata.original_choice).toEqual({ kind: "model", value: "FAST" });
    expect((await publicHttp(`${url}/actions/compile`, { method: "POST", headers: headers(), body: "{}" })).status).toBe(201);
  } finally {
    await app?.close(); await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end();
  }
}, 120000);
