import { randomBytes, randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { expect, it } from "vitest";
import { EngineClient, CostLedgerClient } from "../engine";
import { EngineExceptionFilter } from "../engine/engine-exception.filter";
import { engineConfigFromEnvironment } from "../engine/config";
import type { EngineAuthProvider } from "../engine/auth";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { IdempotencyInterceptor, IdempotencyExceptionFilter, PgIdempotencyStore } from "../idempotency";
import { WorkflowService } from "../workflows/workflow.service";
import { RunService } from "../runs/run.service";
import { CostsService } from "../costs/costs.service";
import type { PlannerFacadeService } from "../planner-facade/planner-facade.service";
import { PlatformWorkflowChatService } from "./platform-workflow-chat.service";
import { PlatformWorkflowChatController } from "./platform-workflow-chat.controller";

// Always launched by the engine's native Model Gateway child. Only the public
// identity-provider edge is controlled; RBAC, idempotency, clients and signed engine guards execute.
it.runIf(Boolean(process.env.WORKFLOW_CHAT_NATIVE_PUBLIC_ASSISTANT))("grounds the public assistant in actual readable runs, verification and billed cost with draft-only action", async () => {
  const fixture = JSON.parse(process.env.WORKFLOW_CHAT_NATIVE_PUBLIC_ASSISTANT!) as { baseUrl: string; costBaseUrl: string; tenant: string; workspace: string; user: string; privateKey: string; directory: string; observed: { workflowId: string; runId: string; nodeId: string; foreignWorkflowId: string; foreignRunId: string; oldRunId: string } };
  const schema = `ask_${randomBytes(8).toString("hex")}`, role = `ask_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
  let pool: pg.Pool | undefined, app: NestFastifyApplication | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`);
    for (const file of readdirSync(resolve("apps/platform-api/src/db/migrations")).filter(file => file.endsWith(".sql")).sort())
      for (const statement of readFileSync(resolve("apps/platform-api/src/db/migrations", file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(statement);
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Native Ask Alter','active')", [fixture.tenant]);
    const password = randomBytes(24).toString("hex"); await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`); await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const uri = new URL(process.env.DATABASE_URL!); uri.username = role; uri.password = password; uri.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: uri.href, max: 4 });
    expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const jwt = (claims: Record<string, unknown>) => { const input = [{ alg: "RS256", kid: "chat-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`; };
    const prefixed = (prefix: string, value: string) => value.startsWith(prefix + "_") ? value : prefix + "_" + value;
    const authorization: EngineAuthProvider = { authorize: async context => { const now = Math.floor(Date.now() / 1000); return {
      m2mAccessToken: jwt({ iss: "https://chat.test/", aud: "alter-engine", iat: now, exp: now + 60 }),
      actorToken: jwt({ user_id: prefixed("usr", context.userId), tenant_id: prefixed("ten", context.tenantId), workspace_id: context.workspaceId ? prefixed("ws", context.workspaceId) : null,
        roles: context.roles, permissions: context.permissions, session_id: context.sessionId, auth_time: now, jti: randomUUID(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }),
    }; } };
    const config = engineConfigFromEnvironment({ ENGINE_BASE_URL: fixture.baseUrl, ADS_CORE_BASE_URL: fixture.baseUrl, COST_LEDGER_BASE_URL: fixture.costBaseUrl,
      AUDIT_SERVICE_BASE_URL: fixture.baseUrl, EVAL_FACADE_TOKEN_REF: "native", DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "native", AUDIT_QUERY_SERVICE_TOKEN_REF: "native",
      ENGINE_M2M_TOKEN_URL: `${fixture.baseUrl}/token`, ENGINE_M2M_AUDIENCE: "alter-engine", ENGINE_M2M_CLIENT_ID: "native", ENGINE_M2M_CLIENT_SECRET_REF: "native" });
    const engine = new EngineClient(config, authorization), ledger = new CostLedgerClient(config, authorization), workflows = new WorkflowService(engine);
    const chats = new PlatformWorkflowChatService(engine, { planWorkflow: async () => { throw Error("Assistant must not invoke builder"); } } as unknown as PlannerFacadeService,
      workflows, new RunService(engine, ledger), new CostsService(ledger, engine));
    const module = await Test.createTestingModule({ imports: [RbacModule], controllers: [PlatformWorkflowChatController], providers: [
      { provide: PlatformWorkflowChatService, useValue: chats }, IdempotencyInterceptor, IdempotencyExceptionFilter,
      { provide: PgIdempotencyStore, useValue: new PgIdempotencyStore(pool, 60000) },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); app.useGlobalFilters(new EngineExceptionFilter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      const value = request.headers["x-native-actor"]; if (typeof value === "string") (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType; done();
    });
    await app.init(); await app.getHttpAdapter().getInstance().ready();
    const caller: ActorContextType = { user_id: fixture.user, tenant_id: fixture.tenant, workspace_id: fixture.workspace, roles: ["viewer"], permissions: [], session_id: "native-ask", auth_time: Math.floor(Date.now() / 1000) };
    const request = (method: "GET" | "POST", url: string, payload?: object, actor = caller, key = randomUUID()) => app!.getHttpAdapter().getInstance().inject({ method, url,
      headers: { "x-native-actor": JSON.stringify(actor), "idempotency-key": key }, ...(payload === undefined ? {} : { payload }) });
    const before = (await workflows.list(undefined, "50", caller, undefined)).body;
    const created = await request("POST", "/api/v1/conversations", { type: "general", title: "Ask Alter" }); expect(created.statusCode, created.body).toBe(201);
    const chat = created.json() as { id: string };
    for (const roleName of ["admin", "editor", "operator", "approver", "viewer"]) expect((await request("GET", `/api/v1/conversations/${chat.id}`, undefined, { ...caller, roles: [roleName] })).statusCode).toBe(200);
    const key = randomUUID(), sent = await request("POST", `/api/v1/conversations/${chat.id}/messages`, { content: "Explain recent failures, verification and billed spend; do not change workflows." }, caller, key);
    expect(sent.statusCode, sent.body).toBe(200); const exchange = sent.json() as { userMessage: { id: string }; assistantMessage: { content: { text: string } } };
    expect(exchange.assistantMessage.content.text).toBe("The recorded invoice run failed its mechanical check. Its billed spend is ₹10.00 INR. No workflow was changed.");
    const repeated = await request("POST", `/api/v1/conversations/${chat.id}/messages`, { content: "Explain recent failures, verification and billed spend; do not change workflows." }, caller, key);
    expect(repeated.statusCode).toBe(200); expect(repeated.headers["idempotency-replayed"]).toBe("true"); expect(repeated.json()).toEqual(exchange);
    expect((await request("POST", `/api/v1/conversations/${chat.id}/messages`, { content: "Different request" }, caller, key)).statusCode).toBe(422);
    for (const payload of [{ content: "Question", snapshot: { workflows: [] } }, { content: "Question", actions: [{ type: "activate" }] }]) expect((await request("POST", `/api/v1/conversations/${chat.id}/messages`, payload)).statusCode).toBe(400);
    const foreignIdentity = "018f4d6e-2b4a-7a3e-8c1a-1234567890ff";
    expect((await request("GET", `/api/v1/conversations/${chat.id}`, undefined, { ...caller, workspace_id: foreignIdentity })).statusCode).toBe(404);
    expect((await request("GET", `/api/v1/conversations/${chat.id}`, undefined, { ...caller, tenant_id: foreignIdentity })).statusCode).toBe(404);
    expect((await request("GET", `/api/v1/conversations/${chat.id}`, undefined, { ...caller, user_id: foreignIdentity })).statusCode).toBe(404);
    expect((await request("POST", "/api/v1/conversations/workflows", { type: "workflow_builder", title: "Forbidden" })).statusCode).toBe(403);
    expect((await request("POST", `/api/v1/conversations/${chat.id}/drafts`, {})).statusCode).toBe(403);
    const after = (await workflows.list(undefined, "50", caller, undefined)).body; expect(after).toEqual(before);
    const draft = await request("POST", `/api/v1/conversations/${chat.id}/drafts`, {}, { ...caller, roles: ["editor"] }); expect(draft.statusCode, draft.body).toBe(201);
    const handoff = draft.json() as { id: string; linkedWorkflowId: string; type: string }; expect(handoff.type).toBe("workflow_builder"); expect(handoff.linkedWorkflowId).not.toBe(fixture.observed.workflowId);
    expect((await workflows.get(handoff.linkedWorkflowId, caller, undefined)).body).toMatchObject({ status: "draft" });
    expect((await workflows.versions(handoff.linkedWorkflowId, undefined, "20", caller, undefined)).body.data).toHaveLength(0);
    expect((await chats.get(handoff.id, caller)).linkedWorkflowId).toBe(handoff.linkedWorkflowId);
    writeFileSync(join(fixture.directory, "public-assistant-result.json"), JSON.stringify(exchange), { mode: 0o600 });
  } finally { await app?.close(); await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
}, 120000);
