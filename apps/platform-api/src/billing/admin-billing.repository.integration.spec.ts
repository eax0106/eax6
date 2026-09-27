import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminBillingRepository } from "./admin-billing.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";

describe.skipIf(!databaseUrl)("AdminBillingRepository PostgreSQL (task B2.2)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: AdminBillingRepository;
  let schemaName: string;
  let roleName: string;
  const failing = randomUUID();
  const suspended = randomUUID();
  const healthy = randomUUID();

  beforeEach(async () => {
    schemaName = `admin_billing_${randomUUID().replaceAll("-", "_")}`;
    roleName = `admin_billing_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION "${schemaName}".admin_list_billing_issues() TO "${roleName}"`);
    // A per-test schema needs explicit USAGE for the SECURITY DEFINER owner
    // (test-only step, as in admin-users.repository.integration.spec.ts).
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO platform_provisioner`);
    await admin.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, 'Failing', 'active'), ($2, 'Suspended', 'active'), ($3, 'Healthy', 'active')`,
      [failing, suspended, healthy],
    );
    await admin.query(
      `INSERT INTO billing_dunning_states (tenant_id, state, current_plan, first_failed_at)
       VALUES ($1, 'grace', 'pro', '2026-09-20T00:00:00Z'),
              ($2, 'suspended', 'team', '2026-09-01T00:00:00Z'),
              ($3, 'active', 'pro', NULL)`,
      [failing, suspended, healthy],
    );
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    repository = new AdminBillingRepository(pool);
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

  it("lists every tenant out of good standing across tenants, newest failure first, and no healthy one", async () => {
    const issues = await repository.listIssues();
    expect(issues.map((i) => [i.tenant_name, i.state, i.current_plan])).toEqual([
      ["Failing", "grace", "pro"],
      ["Suspended", "suspended", "team"],
    ]);
    expect(issues[0]!.first_failed_at).toBe("2026-09-20T00:00:00.000Z");
  });

  it("is the only way in: the same role reading the table directly sees no tenant's row", async () => {
    const direct = await pool.query("SELECT tenant_id FROM billing_dunning_states");
    expect(direct.rowCount).toBe(0);
  });
});

async function applyMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(directory, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
  }
}
