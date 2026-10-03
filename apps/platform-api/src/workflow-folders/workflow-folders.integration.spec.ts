import { randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import pg from "pg";
import { expect, it } from "vitest";
import { EngineClient, EngineExceptionFilter } from "../engine";
import { engineConfigFromEnvironment } from "../engine/config";
import type { EngineAuthProvider } from "../engine/auth";
import { IdempotencyInterceptor, IdempotencyExceptionFilter, PgIdempotencyStore } from "../idempotency";
import { RbacGuard } from "../rbac/rbac.guard";
import { RbacExceptionFilter } from "../rbac/rbac-exception.filter";
import { ParamWorkspaceResolver, defaultWorkspaceResolutionRules } from "../rbac/param-workspace.resolver";
import { WorkspaceResourceTenantResolver, PlatformDbWorkspaceTenantLookup } from "../rbac/resource-tenant.resolver";
import type { ActorContext, RbacRequest, WorkspaceRole } from "../rbac/types";
import { permissionsForRoles } from "../rbac/permissions";
import { PlatformDb } from "../signup/platform-db";
import { PlatformWorkflowFoldersController } from "./workflow-folders.controller";

// Always launched by the engine's signed native test. The public identity edge
// is controlled; public RBAC, idempotency, EngineClient and signed engine guards are real.
it.runIf(Boolean(process.env.WORKFLOW_FOLDERS_NATIVE_BRIDGE))("delivers public folder CRUD and placement through real signed engine transport", async () => {
  const fixture = JSON.parse(process.env.WORKFLOW_FOLDERS_NATIVE_BRIDGE!) as { baseUrl: string; tenantId: string; workspaceId: string; otherWorkspaceId: string; userId: string; workflowId: string; otherFolderId: string; privateKey: string };
  const jwt = (claims: Record<string, unknown>) => { const input = [{ alg: "RS256", kid: "folders-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`; };
  const callers: { workspaceId: string; roles: string[]; permissions: string[] }[] = [];
  const auth: EngineAuthProvider = { authorize: async context => {
    callers.push(context); const now = Math.floor(Date.now() / 1000);
    return { m2mAccessToken: jwt({ iss: "https://folders.test/", aud: "alter-engine", iat: now, exp: now + 60 }),
      actorToken: jwt({ user_id: `usr_${context.userId}`, tenant_id: `ten_${context.tenantId}`, workspace_id: `ws_${context.workspaceId}`, roles: context.roles, permissions: context.permissions, session_id: context.sessionId, auth_time: context.authTime, jti: randomUUID(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60 }) };
  } };
  const config = engineConfigFromEnvironment({ ENGINE_BASE_URL: fixture.baseUrl, ADS_CORE_BASE_URL: fixture.baseUrl, COST_LEDGER_BASE_URL: fixture.baseUrl, AUDIT_SERVICE_BASE_URL: fixture.baseUrl,
    EVAL_FACADE_TOKEN_REF: "native", DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "native", AUDIT_QUERY_SERVICE_TOKEN_REF: "native", ENGINE_M2M_TOKEN_URL: `${fixture.baseUrl}/token`, ENGINE_M2M_AUDIENCE: "alter-engine", ENGINE_M2M_CLIENT_ID: "native", ENGINE_M2M_CLIENT_SECRET_REF: "native" });
  const engine = new EngineClient(config, auth), schema = `folders_${randomUUID().replaceAll("-", "_")}`, role = schema;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
  let pool: pg.Pool | undefined, app: NestFastifyApplication | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`);
    const migrations = resolve("apps/platform-api/src/db/migrations");
    for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort())
      for (const statement of readFileSync(resolve(migrations, file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(statement);
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Native folders','active')", [fixture.tenantId.slice(4)]);
    const password = randomUUID(); await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`); await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const uri = new URL(process.env.DATABASE_URL!); uri.username = role; uri.password = password; uri.searchParams.set("options", `-c search_path=${schema}`); pool = new pg.Pool({ connectionString: uri.href });
    const db = new PlatformDb(pool);
    let actor: ActorContext | undefined;
    const module = await Test.createTestingModule({ controllers: [PlatformWorkflowFoldersController], providers: [
      { provide: EngineClient, useValue: engine }, IdempotencyInterceptor, IdempotencyExceptionFilter,
      { provide: PgIdempotencyStore, useValue: new PgIdempotencyStore(pool, 60000) },
      { provide: APP_GUARD, useValue: new RbacGuard(new Reflector(), new WorkspaceResourceTenantResolver(new PlatformDbWorkspaceTenantLookup(db)), new ParamWorkspaceResolver(defaultWorkspaceResolutionRules({ engineClient: engine, db }))) },
      { provide: APP_FILTER, useClass: EngineExceptionFilter }, { provide: APP_FILTER, useClass: RbacExceptionFilter },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request, _reply, done) => { if (actor) (request as RbacRequest).actorContext = actor; else delete (request as RbacRequest).actorContext; done(); });
    await app.listen(0, "127.0.0.1"); const base = await app.getUrl();
    const asRole = (current: WorkspaceRole) => { actor = { user_id: fixture.userId.slice(4), tenant_id: fixture.tenantId.slice(4), workspace_id: fixture.workspaceId.slice(3), session_id: "native-folders", auth_time: Math.floor(Date.now() / 1000), roles: [current], permissions: permissionsForRoles([current]), workspaceRoles: [{ workspaceId: fixture.workspaceId.slice(3), role: current }] }; };
    // eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- calls this public loopback API; its relay uses the actual EngineClient.
    const request = async (path: string, method = "GET", body?: unknown, etag?: string, key = randomUUID()) => fetch(`${base}/api/v1/${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "Idempotency-Key": key, ...(etag ? { "If-Match": etag } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await request("workflow-folders")).status).toBe(403);
    for (const current of ["admin", "editor", "operator", "approver", "viewer"] as const) {
      asRole(current); const list = await request("workflow-folders"); expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ canEdit: current === "admin" || current === "editor" });
      if (current !== "admin" && current !== "editor") expect((await request("workflow-folders", "POST", { name: "Refused" })).status).toBe(403);
    }
    asRole("editor"); const key = randomUUID(); const created = await request("workflow-folders", "POST", { name: "Public folder" }, undefined, key);
    expect(created.status).toBe(201); const folder = await created.json() as { id: string; etag: string; name: string }; expect(created.headers.get("ETag")).toBe(folder.etag);
    const replay = await request("workflow-folders", "POST", { name: "Public folder" }, undefined, key); expect(await replay.json()).toEqual(folder); expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await request(`workflow-folders/${folder.id}`, "PATCH", { name: "Updated" })).status).toBe(428);
    const renamed = await request(`workflow-folders/${folder.id}`, "PATCH", { name: "Updated" }, folder.etag); expect(renamed.status).toBe(200);
    const updated = await renamed.json() as { etag: string }; expect(renamed.headers.get("ETag")).toBe(updated.etag);
    expect((await request(`workflow-folders/${folder.id}`, "DELETE", undefined, folder.etag)).status).toBe(412);
    const path = `workflows/${fixture.workflowId}/folder`, current = await request(path); expect(current.status).toBe(200);
    const placement = await current.json() as { etag: string }; expect(current.headers.get("ETag")).toBe(placement.etag);
    expect((await request(path, "PUT", { folderId: fixture.otherFolderId }, placement.etag)).status).toBe(404);
    expect((await request(path, "PUT", { folderId: folder.id })).status).toBe(428);
    const moved = await request(path, "PUT", { folderId: folder.id }, placement.etag); expect(moved.status).toBe(200); expect(await moved.json()).toMatchObject({ folderId: folder.id });
    expect((await request(path, "PUT", { folderId: null }, placement.etag)).status).toBe(412);
    expect((await request(`workflow-folders/${folder.id}`, "DELETE", undefined, updated.etag)).status).toBe(204);
    expect(await (await request(path)).json()).toMatchObject({ workflowId: fixture.workflowId, folderId: null });
    asRole("viewer"); actor = { ...actor!, roles: ["viewer", "admin"], permissions: permissionsForRoles(["admin"]), workspaceRoles: [{ workspaceId: fixture.workspaceId.slice(3), role: "viewer" }, { workspaceId: fixture.otherWorkspaceId.slice(3), role: "admin" }] };
    expect((await request("workflow-folders", "POST", { name: "Refused" })).status).toBe(403);
    const list = await request(`workflow-folders?workspaceId=${fixture.otherWorkspaceId}`); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ canEdit: false }); expect(callers.at(-1)).toMatchObject({ workspaceId: fixture.workspaceId.slice(3), roles: ["viewer"], permissions: permissionsForRoles(["viewer"]) });
    asRole("admin"); expect((await request("workflow-folders", "POST", { name: "Invalid", workspaceId: fixture.otherWorkspaceId })).status).toBe(400);
  } finally { await app?.close(); await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
}, 120000);
