import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RbacModule } from "../rbac";
import { AppModule } from "../app.module";
import { PlatformWorkflowTemplatesModule } from "./workflow-templates.module";
import { PlatformDb } from "../signup/platform-db";
import { IdentityService } from "../identity/identity.service";
import { PgSessionStore } from "../identity/session-store";
import { PgIdempotencyStore } from "../idempotency";
import { createCreditPurchaseNativeDriver, type CreditPurchaseNativeDriver } from "../credit-purchases/testing/credit-purchase-native-driver";
import { PlatformWorkflowTemplatesController } from "./workflow-templates.controller";
import { PlatformWorkflowTemplatesService } from "./workflow-templates.service";

const database = process.env.DATABASE_URL;
it("registers templates in the production platform module", () => {
  expect(Reflect.getMetadata("imports", AppModule)).toContain(PlatformWorkflowTemplatesModule);
});
describe.skipIf(!database).sequential("templates current workspace membership over HTTP", () => {
  let d: CreditPurchaseNativeDriver, app: NestFastifyApplication, cookie: string;
  const workspace = uuidv7(), another = uuidv7(), workflowId = `wf_${uuidv7()}`, chatId = `cnv_${workflowId.slice(3)}`;
  const time = new Date().toISOString();
  const upstream = { get: vi.fn(async () => ({ body: [] })), post: vi.fn(async () => ({ body: {
    status: "compiled", templateId: "knowledge-qa", templateVersion: 1, workflowId, versionId: `wfv_${uuidv7()}`,
    conversation: { id: chatId, title: "Knowledge Q&A", type: "workflow_builder", status: "active", createdAt: time, updatedAt: time, linkedWorkflowId: workflowId },
  } })) };
  const audit = { recordEvent: vi.fn(async () => ({})) };
  beforeAll(async () => {
    d = await createCreditPurchaseNativeDriver(database!);
    await d.admin.query("INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'First','active'),($3,$2,'Another','active')", [workspace, d.tenantA, another]);
    await d.admin.query("INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4,'editor','2026-01-01'),($5,$2,$6,$4,'admin','2026-01-02')", [uuidv7(), d.tenantA, workspace, d.userA, uuidv7(), another]);
    const identity = new IdentityService({} as never, new PgSessionStore(d.pool));
    cookie = `alter_access=${(await identity.issueSignupSession(d.userA, d.tenantA)).accessToken}`;
    const templates = new PlatformWorkflowTemplatesService(upstream as never, audit as never);
    const module = await Test.createTestingModule({ imports: [RbacModule], controllers: [PlatformWorkflowTemplatesController], providers: [
      { provide: PlatformWorkflowTemplatesService, useValue: templates }, { provide: PgIdempotencyStore, useValue: new PgIdempotencyStore(d.pool, 3600000) },
    ] }).overrideProvider(IdentityService).useValue(identity).overrideProvider(PlatformDb).useValue(new PlatformDb(d.pool)).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init(); await app.getHttpAdapter().getInstance().ready();
  }, 60000);
  afterAll(async () => { await app?.close(); await d?.close(); }, 60000);
  const create = (session = cookie) => app.inject({ method: "POST", url: "/api/v1/workflow-templates/knowledge-qa/instantiate",
    headers: { cookie: session, "idempotency-key": randomUUID() }, payload: {} });

  it("uses the current cookie identity and selected workspace, and refuses anonymous requests", async () => {
    expect((await create("")).statusCode).toBe(403);
    expect((await create()).statusCode).toBe(201);
    expect(upstream.post).toHaveBeenCalledWith(expect.any(String), {}, expect.objectContaining({ userId: d.userA, tenantId: d.tenantA, workspaceId: workspace }), expect.any(Object));
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ actor_ref: d.userA, tenant_id: d.tenantA }));
  });

  it("requires edit rights in the selected workspace even when another workspace grants admin", async () => {
    upstream.post.mockClear(); audit.recordEvent.mockClear();
    await d.admin.query("UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1", [workspace]);
    expect((await app.inject({ method: "GET", url: "/api/v1/workflow-templates", headers: { cookie } })).statusCode).toBe(200);
    expect((await create()).statusCode).toBe(403);
    expect(upstream.post).not.toHaveBeenCalled(); expect(audit.recordEvent).not.toHaveBeenCalled();
    await d.admin.query("UPDATE workspace_members SET role='editor' WHERE workspace_id=$1", [workspace]);
    expect((await create()).statusCode).toBe(201);
  });
});
