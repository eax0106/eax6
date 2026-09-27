import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminUsersRepository } from "./admin-users.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";

describe.skipIf(!databaseUrl)("AdminUsersRepository PostgreSQL (task B1.2)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: AdminUsersRepository;
  let schemaName: string;
  let roleName: string;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userId = randomUUID();

  beforeEach(async () => {
    schemaName = `admin_users_${randomUUID().replaceAll("-", "_")}`;
    roleName = `admin_users_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION "${schemaName}".admin_list_users(uuid) TO "${roleName}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION "${schemaName}".admin_revoke_user_sessions(uuid) TO "${roleName}"`);
    // See admin-tenants.repository.integration.spec.ts: a per-test schema needs
    // explicit USAGE for the SECURITY DEFINER owner (test-only step).
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO platform_provisioner`);
    await admin.query(
      `INSERT INTO staff_users (id, identity_ref, email, roles)
       VALUES ('stf_test', 'auth0|admin-users-test', 'ops@example.com', ARRAY['staff_admin'])`,
    );
    await admin.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, 'A', 'active'), ($2, 'B', 'active')`,
      [tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO users (id, identity_ref, email, status) VALUES ($1, 'auth0|u', 'person@example.com', 'active')`,
      [userId],
    );
    await admin.query(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES ($1, $2, $4, 'owner'), ($3, $5, $4, 'member')`,
      [randomUUID(), tenantA, randomUUID(), userId, tenantB],
    );
    await admin.query(
      `INSERT INTO user_sessions (id, user_id, tenant_id, refresh_token_hash, access_token_hash)
       VALUES ($1, $3, $4, 'r1', 'a1'), ($2, $3, $5, 'r2', 'a2')`,
      [randomUUID(), randomUUID(), userId, tenantA, tenantB],
    );
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    repository = new AdminUsersRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP OWNED BY "${roleName}"`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("lists a user across tenants, suspends and revokes every session in every tenant", async () => {
    const [listed] = await repository.list();
    expect(listed).toMatchObject({ id: userId, email: "person@example.com", status: "active", active_sessions: 2 });
    expect([...listed!.tenant_ids].sort()).toEqual([tenantA, tenantB].sort());

    expect(await repository.setStatus(userId, "suspended")).toBe(true);
    expect(await repository.revokeSessions(userId)).toBe(2);
    expect(await repository.revokeSessions(userId)).toBe(0);
    expect(await repository.find(userId)).toMatchObject({ status: "suspended", active_sessions: 0 });

    await repository.recordAction(userId, "stf_test", "suspended", "abuse report");
    expect(await repository.listActions(userId)).toEqual([
      expect.objectContaining({ action: "suspended", reason: "abuse report", staff_email: "ops@example.com" }),
    ]);
    await expect(admin.query(`DELETE FROM user_admin_actions`)).rejects.toThrow(/append-only/);
  });
});

async function applyMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  const sql = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n--> statement-breakpoint\n");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await client.query(statement);
  }
}
