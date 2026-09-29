import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformDb } from "../signup/platform-db";
import { MembersService } from "./members.service";

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

// The members screen names people: each membership carries the member's
// email and display name from their user record, and only this tenant's
// memberships are listed.
describe.skipIf(!databaseUrl)("MembersService list, PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let roleName: string;

  beforeEach(async () => {
    schemaName = `members_list_${randomUUID().replaceAll("-", "_")}`;
    roleName = `members_list_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    for (const statement of statements(["0000_platform_db_identity_foundation.sql"])) {
      await admin.query(statement);
    }
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  async function tenant(email: string, name: string | null) {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await admin.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'T', 'active')", [tenantId]);
    await admin.query("INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'Default', 'active')", [workspaceId, tenantId]);
    await admin.query("INSERT INTO users (id, identity_ref, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')", [userId, `auth0|${userId}`, email, name]);
    await admin.query("INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'owner')", [randomUUID(), tenantId, userId]);
    await admin.query("INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4, 'admin')", [randomUUID(), tenantId, workspaceId, userId]);
    return { tenantId, userId };
  }

  it("lists this tenant's memberships with each member's email and name", async () => {
    const mine = await tenant("owner@acme.test", "Ada Owner");
    await tenant("someone@other.test", "Other Tenant");
    const service = new MembersService(new PlatformDb(pool));

    const members = await service.list({ user_id: mine.userId, tenant_id: mine.tenantId, roles: ["owner"], permissions: [], session_id: "s" });

    expect(members.map((member) => [member.scope, member.role, member.email, member.name])).toEqual([
      ["tenant", "owner", "owner@acme.test", "Ada Owner"],
      ["workspace", "admin", "owner@acme.test", "Ada Owner"],
    ]);
  });
});
