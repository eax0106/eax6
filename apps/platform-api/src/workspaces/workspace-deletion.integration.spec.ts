import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineClient } from "../engine";
import type { IdentityService } from "../identity/identity.service";
import { ActorContextGuard } from "../rbac/actor-context.guard";
import type { ActorContext, RbacRequest } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { WorkspaceDeletionService } from "./workspace-deletion.service";
import { WorkspaceErasureRunner } from "./workspace-erasure.runner";
import { WorkspacesService } from "./workspaces.service";

const databaseUrl = process.env.DATABASE_URL ?? "";
const migrationsPath = join(__dirname, "../db/migrations");

function statements(files: string[]): string[] {
  return files
    .map((file) => readFileSync(join(migrationsPath, file), "utf8"))
    .join("\n--> statement-breakpoint\n")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// D2 workspace pending deletion on a real platform database: typed-name
// confirmation, the engine hold placed before the workspace is marked, the
// hidden list, the undo window, and no workspace role while pending.
describe.skipIf(!databaseUrl)("workspace pending deletion, PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let roleName: string;
  let workspaces: WorkspacesService;
  let deletion: WorkspaceDeletionService;
  let engine: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let audit: { recordEvent: ReturnType<typeof vi.fn> };
  let db: PlatformDb;
  let actor: ActorContext;
  let tenantId: string;
  let workspaceId: string;
  let calls: string[];

  beforeEach(async () => {
    schemaName = `workspace_deletion_${randomUUID().replaceAll("-", "_")}`;
    roleName = `workspace_deletion_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    for (const statement of statements([
      "0000_platform_db_identity_foundation.sql",
      "0019_workspace_safeguards.sql",
      "0030_workspace_pending_deletion.sql",
    ])) {
      await admin.query(statement);
    }
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    db = new PlatformDb(pool);

    calls = [];
    engine = {
      put: vi.fn(async (path: string) => {
        calls.push(`hold ${path}`);
        return { status: 204, body: undefined, headers: {} };
      }),
      delete: vi.fn(async (path: string) => {
        calls.push(`release ${path}`);
        return { status: 204, body: undefined, headers: {} };
      }),
    };
    audit = { recordEvent: vi.fn(async (event: { action: string }) => { calls.push(event.action); return {}; }) };
    workspaces = new WorkspacesService(db);
    deletion = new WorkspaceDeletionService(
      db,
      engine as unknown as EngineClient,
      audit as unknown as AuditEventHandler,
      7,
    );

    tenantId = randomUUID();
    workspaceId = randomUUID();
    await admin.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Deletion Tenant', 'active')", [tenantId]);
    await admin.query("INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'Marketing', 'active')", [workspaceId, tenantId]);
    actor = { user_id: randomUUID(), tenant_id: tenantId, roles: ["admin"], permissions: [], session_id: "session" };
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  async function status(): Promise<{ status: string; due: Date | null; by: string | null }> {
    const result = await admin.query<{ status: string; due: Date | null; by: string | null }>(
      "SELECT status, deletion_due_at AS due, deletion_requested_by AS by FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    return result.rows[0]!;
  }

  it("refuses a confirmation that is not the exact workspace name, touching nothing", async () => {
    for (const confirm of [undefined, "marketing", "Marketing ", 42]) {
      await expect(deletion.requestDeletion(actor, `ws_${workspaceId}`, confirm)).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ title: "WORKSPACE_CONFIRM_NAME_MISMATCH" }),
      });
    }
    expect(engine.put).not.toHaveBeenCalled();
    await expect(status()).resolves.toMatchObject({ status: "active", due: null });
  });

  it("holds the workspace in the engine first, then marks it pending for the window, hidden and audited", async () => {
    const before = Date.now();
    const view = await deletion.requestDeletion(actor, `ws_${workspaceId}`, "Marketing");

    expect(calls).toEqual([`hold /api/v1/workspace-holds/ws_${workspaceId}`, "workspace.deletion.request"]);
    expect(view.status).toBe("pending_deletion");
    const row = await status();
    expect(row).toMatchObject({ status: "pending_deletion", by: actor.user_id });
    const windowMs = row.due!.getTime() - before;
    expect(windowMs).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(windowMs).toBeLessThan(7 * 86_400_000 + 60_000);

    await expect(workspaces.list(actor)).resolves.toEqual([]);
    await expect(workspaces.listPendingDeletion(actor)).resolves.toMatchObject([{ id: workspaceId, name: "Marketing" }]);
    await expect(deletion.requestDeletion(actor, workspaceId, "Marketing")).rejects.toMatchObject({ status: 409 });
  });

  it("restores within the window: active again, visible, audited, and the engine hold released last", async () => {
    await deletion.requestDeletion(actor, workspaceId, "Marketing");
    calls.length = 0;

    await expect(deletion.restore(actor, `ws_${workspaceId}`)).resolves.toMatchObject({ status: "active" });
    expect(calls).toEqual(["workspace.deletion.restore", `release /api/v1/workspace-holds/ws_${workspaceId}`]);
    await expect(status()).resolves.toMatchObject({ status: "active", due: null, by: null });
    await expect(workspaces.list(actor)).resolves.toMatchObject([{ id: workspaceId }]);
  });

  it("a repeated restore after a failed hold release releases it again", async () => {
    await deletion.requestDeletion(actor, workspaceId, "Marketing");
    engine.delete.mockRejectedValueOnce(new Error("engine unavailable"));
    await expect(deletion.restore(actor, workspaceId)).rejects.toThrow("engine unavailable");
    await expect(status()).resolves.toMatchObject({ status: "active" });

    calls.length = 0;
    await expect(deletion.restore(actor, workspaceId)).resolves.toMatchObject({ status: "active" });
    expect(calls).toEqual([`release /api/v1/workspace-holds/ws_${workspaceId}`]);
  });

  it("refuses a restore once the window has ended", async () => {
    await deletion.requestDeletion(actor, workspaceId, "Marketing");
    await admin.query("UPDATE workspaces SET deletion_due_at = now() - interval '1 second' WHERE id = $1", [workspaceId]);
    engine.delete.mockClear();

    await expect(deletion.restore(actor, workspaceId)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ title: "WORKSPACE_DELETION_WINDOW_ENDED" }),
    });
    expect(engine.delete).not.toHaveBeenCalled();
    await expect(status()).resolves.toMatchObject({ status: "pending_deletion" });
  });

  it("leaves the workspace active when the engine hold fails, and releases the hold when marking fails", async () => {
    engine.put.mockRejectedValueOnce(new Error("engine unavailable"));
    await expect(deletion.requestDeletion(actor, workspaceId, "Marketing")).rejects.toThrow("engine unavailable");
    await expect(status()).resolves.toMatchObject({ status: "active" });

    audit.recordEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    calls.length = 0;
    await expect(deletion.requestDeletion(actor, workspaceId, "Marketing")).rejects.toThrow("audit unavailable");
    expect(calls).toEqual([
      `hold /api/v1/workspace-holds/ws_${workspaceId}`,
      `release /api/v1/workspace-holds/ws_${workspaceId}`,
    ]);
    await expect(status()).resolves.toMatchObject({ status: "active", due: null });
  });

  it("the sweep erases only workspaces past their window, through audit-service, and retries failures (D2)", async () => {
    const notDue = randomUUID();
    const failing = randomUUID();
    await admin.query(
      "INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $3, 'Later', 'active'), ($2, $3, 'Flaky', 'active')",
      [notDue, failing, tenantId],
    );
    for (const [id, name] of [[workspaceId, "Marketing"], [notDue, "Later"], [failing, "Flaky"]] as const) {
      await deletion.requestDeletion(actor, id, name);
    }
    await admin.query(
      "UPDATE workspaces SET deletion_due_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])",
      [[workspaceId, failing]],
    );
    const erased: string[] = [];
    const erasure = {
      executeWorkspaceErasure: vi.fn(async (_tenant: string, workspace: string) => {
        if (workspace === `ws_${failing}`) throw new Error("verification failed");
        erased.push(workspace);
        // platform-api's own share of the erasure removes the row.
        await admin.query("DELETE FROM workspaces WHERE id = $1", [workspace.slice(3)]);
        return { manifestId: "del_fixture", completed: true };
      }),
    };
    audit.recordEvent.mockClear();
    const runner = new WorkspaceErasureRunner({ listActiveTenantIds: async () => [tenantId] }, db, erasure, audit as unknown as AuditEventHandler);

    await expect(runner.run()).resolves.toEqual({ tenants: 1, tenantsFailed: 0, workspacesErased: 1, workspacesFailed: 1 });
    expect(erasure.executeWorkspaceErasure).toHaveBeenCalledWith(`ten_${tenantId}`, `ws_${workspaceId}`);
    expect(erasure.executeWorkspaceErasure).not.toHaveBeenCalledWith(`ten_${tenantId}`, `ws_${notDue}`);
    expect(erased).toEqual([`ws_${workspaceId}`]);
    expect(audit.recordEvent).toHaveBeenCalledTimes(1);
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.deletion.erase", target_ref: workspaceId, actor_type: "system" }));
    const left = await admin.query<{ id: string; status: string }>("SELECT id::text, status FROM workspaces WHERE tenant_id = $1 ORDER BY name", [tenantId]);
    expect(left.rows).toEqual([{ id: failing, status: "pending_deletion" }, { id: notDue, status: "pending_deletion" }]);
  });

  it("grants no workspace role in a workspace pending deletion", async () => {
    const userId = randomUUID();
    const otherWorkspace = randomUUID();
    await admin.query("INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'Other', 'active')", [otherWorkspace, tenantId]);
    await admin.query("INSERT INTO users (id, identity_ref, email, status) VALUES ($1, 'ref', 'member@example.test', 'active')", [userId]);
    await admin.query(
      "INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, 'editor', now() - interval '1 day'), ($5, $2, $6, $4, 'viewer', now())",
      [randomUUID(), tenantId, workspaceId, userId, randomUUID(), otherWorkspace],
    );
    const guard = new ActorContextGuard(
      { authenticateAccessToken: vi.fn().mockResolvedValue({ id: "session", userId, tenantId, createdAt: new Date() }) } as unknown as IdentityService,
      db,
    );
    async function resolve() {
      const request: RbacRequest & { headers: { cookie?: string } } = { headers: { cookie: "alter_access=token" } };
      await guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext);
      return request.actorContext!;
    }

    await expect(resolve()).resolves.toMatchObject({ workspace_id: workspaceId, roles: ["editor", "viewer"] });
    await deletion.requestDeletion(actor, workspaceId, "Marketing");
    const pending = await resolve();
    expect(pending.workspace_id).toBe(otherWorkspace);
    expect(pending.workspaceRoles).toEqual([{ workspaceId: otherWorkspace, role: "viewer" }]);
  });
});
