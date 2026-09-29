import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEventHandler } from "@alterx/shared-clients";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../rbac/types";
import { PlatformDbWorkspaceTenantLookup } from "../rbac/resource-tenant.resolver";
import { PlatformDb } from "../signup/platform-db";
import { WorkspaceSafeguardsService } from "./workspace-safeguards.service";
import { WorkspacesService, workspaceEtag } from "./workspaces.service";

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

// The workspace routes are addressed with the database's bare UUID and with
// the ws_ form other surfaces use. Both must find the workspace; anything
// else is a workspace that does not exist (404), never a server error.
describe.skipIf(!databaseUrl)("workspace ids, PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let roleName: string;
  let workspaces: WorkspacesService;
  let safeguards: WorkspaceSafeguardsService;
  let actor: ActorContext;
  let workspaceId: string;

  beforeEach(async () => {
    schemaName = `workspace_ids_${randomUUID().replaceAll("-", "_")}`;
    roleName = `workspace_ids_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    for (const statement of statements(["0000_platform_db_identity_foundation.sql", "0019_workspace_safeguards.sql"])) {
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
    const db = new PlatformDb(pool);
    workspaces = new WorkspacesService(db);
    safeguards = new WorkspaceSafeguardsService(db, { recordEvent: vi.fn().mockResolvedValue({}), getEvent: vi.fn() } as unknown as AuditEventHandler);

    const tenantId = randomUUID();
    workspaceId = randomUUID();
    await admin.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Ids Tenant', 'active')", [tenantId]);
    await admin.query("INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'Default', 'active')", [workspaceId, tenantId]);
    actor = { user_id: randomUUID(), tenant_id: tenantId, roles: ["owner"], permissions: [], session_id: "session" };
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("reads and renames a workspace by its bare or ws_ id", async () => {
    await expect(workspaces.get(actor, workspaceId)).resolves.toMatchObject({ id: workspaceId });
    const prefixed = await workspaces.get(actor, `ws_${workspaceId}`);
    expect(prefixed).toMatchObject({ id: workspaceId, name: "Default" });

    const renamed = await workspaces.update(actor, `ws_${workspaceId}`, "Renamed", workspaceEtag(prefixed));
    expect(renamed).toMatchObject({ id: workspaceId, name: "Renamed" });
  });

  it("lets the RBAC guard resolve the workspace's tenant from a ws_ id, and a malformed id resolve to nothing", async () => {
    const lookup = new PlatformDbWorkspaceTenantLookup(new PlatformDb(pool));
    await expect(lookup.queryWorkspaceTenant(actor.tenant_id, workspaceId)).resolves.toBe(actor.tenant_id);
    await expect(lookup.queryWorkspaceTenant(actor.tenant_id, `ws_${workspaceId}`)).resolves.toBe(actor.tenant_id);
    await expect(lookup.queryWorkspaceTenant(actor.tenant_id, "not-a-workspace")).resolves.toBeUndefined();
    await expect(lookup.queryWorkspaceTenant(randomUUID(), `ws_${workspaceId}`)).resolves.toBeUndefined();
  });

  it("reads safeguards by the ws_ id", async () => {
    await expect(safeguards.get(actor, `ws_${workspaceId}`)).resolves.toMatchObject({
      safeguards: { contains_pii: true, approve_external_actions: true },
    });
  });

  it("answers 404, not a server error, for an id that is not a workspace id or belongs to another tenant", async () => {
    for (const id of ["ws_not-a-uuid", "anything", `wf_${workspaceId}`]) {
      await expect(workspaces.get(actor, id)).rejects.toMatchObject({ status: 404 });
    }
    await expect(workspaces.get({ ...actor, tenant_id: randomUUID() }, `ws_${workspaceId}`)).rejects.toMatchObject({ status: 404 });
  });
});
