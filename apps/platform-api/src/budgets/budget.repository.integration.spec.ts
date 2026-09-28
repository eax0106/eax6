import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetRepository } from "./budget.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-0000000000a1";
const workspaceA2 = "00000000-0000-7000-8000-0000000000a2";
const workspaceB = "00000000-0000-7000-8000-0000000000b1";

function budget(tenantId: string, workspaceId: string, name = "Monthly") {
  return {
    tenantId,
    workspaceId,
    id: "bud_018f4d6e-2b4a-7a3e-8c1a-" + randomUUID().slice(-12),
    name,
    amountMinor: 500_00,
    currency: "INR" as const,
    period: "monthly" as const,
    thresholds: [{ percent: 80, action: "warn" as const }, { percent: 100, action: "block" as const }],
    enabled: true,
    createdBy: "usr_1",
  };
}

describe.skipIf(!databaseUrl)("BudgetRepository PostgreSQL RLS (task B2.9b)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: BudgetRepository;
  let schemaName: string;
  let roleName: string;

  beforeEach(async () => {
    schemaName = `budgets_${randomUUID().replaceAll("-", "_")}`;
    roleName = `budgets_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    await admin.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, 'Tenant A', 'active'), ($2, 'Tenant B', 'active')`,
      [tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO workspaces (id, tenant_id, name, status)
       VALUES ($1, $2, 'A', 'active'), ($3, $2, 'A2', 'active'), ($4, $5, 'B', 'active')`,
      [workspaceA, tenantA, workspaceA2, workspaceB, tenantB],
    );
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    repository = new BudgetRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("stores, lists, updates and deletes a workspace's budgets", async () => {
    const created = await repository.insert(budget(tenantA, workspaceA));
    expect(created).toMatchObject({ amountMinor: 50_000, currency: "INR", enabled: true });
    expect(created.thresholds).toEqual([{ percent: 80, action: "warn" }, { percent: 100, action: "block" }]);
    const updated = await repository.update(tenantA, workspaceA, created.id, { amountMinor: 1_000_00, enabled: false });
    expect(updated).toMatchObject({ name: "Monthly", amountMinor: 100_000, enabled: false });
    expect((await repository.list(tenantA, workspaceA)).map((b) => b.id)).toEqual([created.id]);
    await expect(repository.remove(tenantA, workspaceA, created.id)).resolves.toBe(true);
    await expect(repository.list(tenantA, workspaceA)).resolves.toEqual([]);
  });

  it("keeps each workspace's and each tenant's budgets to itself", async () => {
    const own = await repository.insert(budget(tenantA, workspaceA));
    await repository.insert(budget(tenantB, workspaceB));
    expect((await repository.list(tenantA, workspaceA2))).toEqual([]);
    await expect(repository.update(tenantA, workspaceA2, own.id, { enabled: false })).resolves.toBeUndefined();
    await expect(repository.remove(tenantB, workspaceB, own.id)).resolves.toBe(false);
    // Tenant B's context cannot see tenant A's row even when asked for it by id and workspace.
    await expect(repository.update(tenantB, workspaceA, own.id, { enabled: false })).resolves.toBeUndefined();
    expect((await repository.list(tenantA, workspaceA))[0]).toMatchObject({ enabled: true });
    // Row-level security, not just the WHERE clause: no tenant context, no rows.
    expect((await pool.query("SELECT id FROM budgets")).rowCount).toBe(0);
  });

  it("refuses a budget placed in another tenant's workspace and a non-positive amount", async () => {
    await expect(repository.insert(budget(tenantA, workspaceB))).rejects.toThrow();
    await expect(repository.insert({ ...budget(tenantA, workspaceA), amountMinor: 0 })).rejects.toThrow(/budgets_amount_positive/);
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
