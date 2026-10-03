import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryServiceClient } from "@alterx/adapters";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { expect, it } from "vitest";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { MemorySettingsModule } from "./memory-settings.module";
import { MemorySettingsService } from "./memory-settings.service";

it.runIf(Boolean(process.env["MEMORY_SETTINGS_NATIVE_CONFIG"]))("serves actual memory settings over public HTTP and memory gRPC with workspace RBAC", async () => {
  const fixture = JSON.parse(readFileSync(process.env["MEMORY_SETTINGS_NATIVE_CONFIG"]!, "utf8")) as { address: string; tenant: string; otherTenant: string; workspace: string; otherWorkspace: string; user: string };
  const client = new MemoryServiceClient({ address: fixture.address, protoPath: resolve("packages/contracts/proto/alter/memory/v1/memory.proto"), authorization: "Bearer integration-token" });
  const service = new MemorySettingsService(client);
  const module = await Test.createTestingModule({ imports: [RbacModule, MemorySettingsModule] }).overrideProvider(MemorySettingsService).useValue(service).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
    const raw = request.headers["x-fixture-actor"]; if (typeof raw === "string") (request as RbacRequest).actorContext = JSON.parse(raw) as ActorContextType;
    done();
  });
  const actor = (role = "admin", tenant = fixture.tenant, workspace = fixture.workspace): ActorContextType => ({
    tenant_id: tenant, workspace_id: workspace, user_id: fixture.user, session_id: "native-memory-session",
    roles: [role], permissions: [], workspaceRoles: [{ workspaceId: workspace, role }],
  });
  const defaults = { conversationMemoryEnabled: true, workflowMemoryEnabled: true, workspaceMemoryEnabled: true, retentionDays: 90, etag: '"memory-0"' };
  const values = { conversationMemoryEnabled: false, workflowMemoryEnabled: true, workspaceMemoryEnabled: false, retentionDays: 7 };
  try {
    await app.listen(0, "127.0.0.1"); const base = await app.getUrl();
    const request = (caller: ActorContextType | undefined, method = "GET", body?: unknown, etag?: string) => fetch(`${base}/api/v1/memory-settings?workspace_id=${fixture.otherWorkspace}`, {
      method, headers: { ...(caller ? { "x-fixture-actor": JSON.stringify(caller) } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(etag ? { "if-match": etag } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect((await request(undefined)).status).toBe(403);
    for (const role of ["admin", "editor", "operator", "approver", "viewer"]) {
      const response = await request(actor(role)); expect(response.status).toBe(200); expect(response.headers.get("etag")).toBe(defaults.etag); expect(await response.json()).toEqual(defaults);
    }
    for (const role of ["editor", "operator", "approver", "viewer"]) expect((await request(actor(role), "PUT", values, defaults.etag)).status).toBe(403);
    const foreignBinding = { ...actor(), workspaceRoles: [{ workspaceId: fixture.otherWorkspace, role: "admin" }, { workspaceId: fixture.workspace, role: "viewer" }] };
    expect((await request(foreignBinding, "PUT", values, defaults.etag)).status).toBe(403);
    const missingWorkspace = actor(); delete missingWorkspace.workspace_id;
    expect((await request(missingWorkspace)).status).toBe(403);
    expect((await request(actor(), "PUT", values)).status).toBe(428);
    for (const invalid of [{ ...values, retentionDays: 6 }, { ...values, retentionDays: 366 }, { ...values, conversationMemoryEnabled: "false" }, { ...values, allowSensitiveData: true }]) expect((await request(actor(), "PUT", invalid, defaults.etag)).status).toBe(400);
    const saved = await request(actor(), "PUT", values, defaults.etag); expect(saved.status).toBe(200); expect(saved.headers.get("etag")).toBe('"memory-1"'); expect(await saved.json()).toEqual({ ...values, etag: '"memory-1"' });
    const stale = await request(actor(), "PUT", values, defaults.etag); expect(stale.status).toBe(412); expect(await stale.json()).toMatchObject({ error_code: "ETAG_MISMATCH" });
    expect(await (await request(actor())).json()).toEqual({ ...values, etag: '"memory-1"' });
    for (const caller of [actor("admin", fixture.otherTenant), actor("admin", fixture.tenant, fixture.otherWorkspace)]) expect(await (await request(caller)).json()).toEqual(defaults);
  } finally { await app.close(); }
}, 120000);
