import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformDb } from "../signup/platform-db";
import { WorkspaceExportHttpError } from "./problem";
import { WorkspaceExportService } from "./workspace-export.service";

// D2 (C74): export records on real Postgres with the real migrations,
// through a non-owner role held to row security. The audit sink is fake;
// everything else is real.
const databaseUrl = process.env.DATABASE_URL ?? "";
const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000b1";
const wsA = "00000000-0000-7000-8000-00000000a101";
const wsB = "00000000-0000-7000-8000-00000000b101";
const adminA = "00000000-0000-7000-8000-0000000001a1";

const actor = {
  user_id: adminA,
  tenant_id: A,
  workspace_id: wsA,
  session_id: "export-test",
  roles: ["admin"],
  permissions: ["workflows:read", "runs:read", "knowledge:read"],
};

describe.skipIf(!databaseUrl)("WorkspaceExportService on PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let audit: { recordEvent: ReturnType<typeof vi.fn> };
  let service: WorkspaceExportService;

  beforeEach(async () => {
    schemaName = `exports_${randomUUID().replaceAll("-", "_")}`;
    const roleName = `exports_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}", public`);
    const directory = join(__dirname, "../db/migrations");
    const sql = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(join(directory, file), "utf8"))
      .join("\n--> statement-breakpoint\n");
    for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await admin.query(statement);
    }
    for (const tenant of [A, B]) {
      await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'T', 'active')`, [tenant]);
    }
    await admin.query(`INSERT INTO users (id, identity_ref, email, display_name, status) VALUES ($1, 'auth0|x', 'a@example.com', 'A', 'active')`, [adminA]);
    await admin.query(`INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'W', 'active')`, [wsA, A]);
    await admin.query(`INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'W', 'active')`, [wsB, B]);
    await admin.query(`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3, 'admin')`, [A, wsA, adminA]);

    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    audit = { recordEvent: vi.fn(async () => ({})) };
    service = new WorkspaceExportService(new PlatformDb(pool), audit as never);
  });

  afterEach(async () => {
    await pool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("holds the session to row security", async () => {
    const roles = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("requests an export as requested and audits it", async () => {
    const created = await service.request(actor, `ws_${wsA}`);
    expect(created.id).toMatch(/^exp_/);
    expect(created.workspaceId).toBe(`ws_${wsA}`);
    expect(created.status).toBe("requested");
    expect(created.failureReason).toBeNull();
    expect(created.expiresAt).toBeNull();
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: A,
      action: "workspace.exports.request",
      target_type: "workspace",
      target_ref: wsA,
      result: "success",
    }));
  });

  it("keeps another tenant's and workspace's exports out of reach", async () => {
    const created = await service.request(actor, `ws_${wsA}`);
    await expect(service.get({ ...actor, tenant_id: B }, `ws_${wsA}`, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(actor, `ws_${wsB}`, created.id)).rejects.toMatchObject({ status: 404 });
    expect(await service.list({ ...actor, tenant_id: B }, `ws_${wsA}`)).toEqual([]);
    await expect(service.download({ ...actor, tenant_id: B }, `ws_${wsA}`, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("serves a ready archive, never a failed or expired one", async () => {
    const created = await service.request(actor, `ws_${wsA}`);
    const bare = created.id.slice("exp_".length);
    const archive = { exportedAt: "2026-09-30T10:05:00.000Z", workspaceId: `ws_${wsA}`, workflows: [], workflowVersions: [], runs: [], knowledgeSources: [], knowledgeDocuments: [], members: [] };
    await admin.query(`UPDATE workspace_exports SET status = 'ready', archive = $1, expires_at = now() + interval '7 days' WHERE id = $2`, [JSON.stringify(archive), bare]);
    const downloaded = await service.download(actor, `ws_${wsA}`, created.id);
    expect(downloaded).toEqual(archive);

    await admin.query(`UPDATE workspace_exports SET status = 'failed', failure_reason = 'ads down', archive = NULL WHERE id = $1`, [bare]);
    await expect(service.download(actor, `ws_${wsA}`, created.id)).rejects.toMatchObject({ status: 404 });

    await admin.query(`UPDATE workspace_exports SET status = 'ready', archive = $1, expires_at = now() - interval '1 second' WHERE id = $2`, [JSON.stringify(archive), bare]);
    await expect(service.download(actor, `ws_${wsA}`, created.id)).rejects.toMatchObject({ status: 410 });
  });

  it("rejects malformed ids as not found", async () => {
    await expect(service.request(actor, "garbage")).rejects.toMatchObject({ status: 404 });
    await expect(service.get(actor, `ws_${wsA}`, "exp_garbage")).rejects.toMatchObject({ status: 404 });
    await expect(service.get(actor, `ws_${wsA}`, "wf_00000000-0000-7000-8000-0000000000a1")).rejects.toMatchObject({ status: 404 });
    await expect(service.request(actor, `ws_${wsA}`).then(() => service.download(actor, `ws_${wsA}`, "exp_00000000-0000-7000-8000-0000000000ff"))).rejects.toMatchObject({ status: 404 });
  });

  it("proves the not-found on an unknown but well-formed export", async () => {
    const missing = await service.get(actor, `ws_${wsA}`, "exp_00000000-0000-7000-8000-0000000000ff").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(WorkspaceExportHttpError);
    expect((missing as WorkspaceExportHttpError).getStatus()).toBe(404);
  });
});
