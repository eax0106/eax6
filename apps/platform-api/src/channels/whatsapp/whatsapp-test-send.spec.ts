import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineClient, type EngineCallerContext } from "../../engine";
import { IdempotencyExceptionFilter, IdempotencyInterceptor, PgIdempotencyStore } from "../../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../../rbac";
import { secretsProviderToken } from "../../identity-broker/identity-broker.module";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappService } from "./whatsapp.service";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenant = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-000000000002";
const actor: ActorContextType = { user_id: `usr_${tenant}`, tenant_id: tenant, workspace_id: workspace,
  session_id: "whatsapp-fixture", auth_time: 1, roles: ["editor"], permissions: ["integrations:read", "integrations:write"] };
const account = { id: "wac_fixture", workspaceId: `ws_${workspace}`, phoneNumberId: "phone-fixture", wabaId: "business-fixture", accessTokenRef: "secret://whatsapp-fixture", status: "connected" };
const message = { to: "+15551234567", templateName: "hello", languageCode: "fr_FR" };

describe.skipIf(!databaseUrl)("WhatsApp test-send guarded HTTP and PostgreSQL", () => {
  let app: NestFastifyApplication, admin: pg.Client, pool: pg.Pool;
  const schema = `wa_${randomBytes(8).toString("hex")}`, role = `wa_role_${randomBytes(8).toString("hex")}`;
  let providerRejects = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    return new Response(JSON.stringify(url.endsWith("/message_templates") ? { data: [{ name: "hello", language: "fr_FR", status: "APPROVED" }] }
      : providerRejects ? { error: { message: "fixture rejected" } } : { messages: [{ id: "wamid.accepted" }] }),
    { status: providerRejects ? 400 : 200 });
  });
  const getSecret = vi.fn(async () => "fixture-token");
  const get = vi.fn(async (_path: string, context: EngineCallerContext) => {
    void _path;
    return { status: 200, body: { accounts: context.tenantId === tenant ? [account] : [] } };
  });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`);
    const directory = resolve("apps/platform-api/src/db/migrations");
    for (const file of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) {
      for (const statement of readFileSync(resolve(directory, file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
        await admin.query(statement);
      }
    }
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'WhatsApp fixture','active')", [tenant]);
    const password = randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const uri = new URL(databaseUrl); uri.username = role; uri.password = password; uri.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: uri.href, max: 4 });
    vi.stubGlobal("fetch", fetcher);
    const module = await Test.createTestingModule({ imports: [RbacModule], controllers: [WhatsappController], providers: [
      WhatsappService, IdempotencyInterceptor, IdempotencyExceptionFilter,
      { provide: PgIdempotencyStore, useValue: new PgIdempotencyStore(pool, 60_000) },
      { provide: EngineClient, useValue: { get } }, { provide: secretsProviderToken, useValue: { getSecret } },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      const value = request.headers["x-test-actor"];
      if (typeof value === "string") (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType;
      done();
    });
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  }, 120_000);
  beforeEach(() => { providerRejects = false; fetcher.mockClear(); get.mockClear(); getSecret.mockClear(); });
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
    vi.unstubAllGlobals();
  });
  function send(body: unknown = message, caller: ActorContextType | undefined = actor, key: string | undefined = randomUUID()) {
    return app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/api/v1/channels/whatsapp/accounts/${account.id}/test-send`, payload: body as Record<string, unknown>,
      headers: { ...(caller ? { "x-test-actor": JSON.stringify(caller) } : {}), ...(key ? { "idempotency-key": key } : {}) } });
  }

  it("lists actual templates as the caller and collapses concurrent accepted sends with the exact language", async () => {
    const roleRow = await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    expect(roleRow.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const templates = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/api/v1/channels/whatsapp/accounts/${account.id}/templates`, headers: { "x-test-actor": JSON.stringify(actor) } });
    expect(templates.statusCode).toBe(200); expect(templates.json()).toEqual([{ name: "hello", language: "fr_FR", status: "APPROVED" }]);
    fetcher.mockClear(); const key = randomUUID();
    const responses = await Promise.all([send(message, actor, key), send(message, actor, key), send(message, actor, key)]);
    expect(responses.map(response => response.statusCode)).toEqual([201, 201, 201]);
    for (const response of responses) expect(response.json()).toEqual({ messageId: "wamid.accepted" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe("https://graph.facebook.com/v21.0/phone-fixture/messages");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ messaging_product: "whatsapp", to: "15551234567", type: "template", template: { name: "hello", language: { code: "fr_FR" } } });
    expect(get).toHaveBeenCalledWith("/api/v1/channels/whatsapp/accounts", expect.objectContaining({ userId: actor.user_id, tenantId: tenant, workspaceId: workspace }));
    expect(getSecret).toHaveBeenCalledWith(account.accessTokenRef);
    expect((await send({ ...message, to: "15557654321" }, actor, key)).statusCode).toBe(422);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("denies missing role, permission, workspace, tenant and request key before any provider send", async () => {
    expect((await send(message, { ...actor, roles: ["viewer"] })).statusCode).toBe(403);
    expect((await send(message, { ...actor, permissions: ["integrations:read"] })).statusCode).toBe(403);
    expect((await send(message, { ...actor, workspace_id: "00000000-0000-7000-8000-000000000003" })).statusCode).toBe(404);
    expect((await send(message, { ...actor, tenant_id: "00000000-0000-7000-8000-000000000004" })).statusCode).toBe(404);
    expect((await send(message, actor, "")).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled(); expect(getSecret).not.toHaveBeenCalled();
  });

  it("rejects malformed recipient, template and language without reaching Meta", async () => {
    for (const body of [{ ...message, to: "invalid" }, { ...message, to: null }, { ...message, templateName: "" }, { ...message, languageCode: [] }]) {
      expect((await send(body)).statusCode).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces provider rejection and does not cache it as an accepted send", async () => {
    const key = randomUUID(); providerRejects = true;
    expect((await send(message, actor, key)).statusCode).toBe(500);
    providerRejects = false;
    const retry = await send(message, actor, key);
    expect(retry.statusCode).toBe(201); expect(retry.json()).toEqual({ messageId: "wamid.accepted" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
