import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryBindingRepository } from "./repository-binding.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-0000000000a1";
const workspaceB = "00000000-0000-7000-8000-0000000000b1";

function binding(tenantId: string, workspaceId: string, externalId = "42") {
  return {
    tenantId,
    workspaceId,
    id: "rep_018f4d6e-2b4a-7a3e-8c1a-" + randomUUID().slice(-12),
    provider: "github" as const,
    connectionId: "00000000-0000-7000-8000-0000000000c1",
    externalId,
    fullName: "alterx/engine",
    defaultBranch: "main",
    private: true,
    htmlUrl: "https://github.com/alterx/engine",
    createdBy: "usr_1",
  };
}

describe.skipIf(!databaseUrl)("RepositoryBindingRepository PostgreSQL RLS", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: RepositoryBindingRepository;
  let schemaName: string;
  let roleName: string;

  beforeEach(async () => {
    schemaName = `repo_binding_${randomUUID().replaceAll("-", "_")}`;
    roleName = `repo_binding_role_${randomUUID().replaceAll("-", "_")}`;
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
       VALUES ($1, $2, 'A', 'active'), ($3, $4, 'B', 'active')`,
      [workspaceA, tenantA, workspaceB, tenantB],
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
    repository = new RepositoryBindingRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("isolates tenants, deduplicates per repository, and holds no credential column", async () => {
    const stored = await repository.insert(binding(tenantA, workspaceA));
    expect(stored?.fullName).toBe("alterx/engine");
    expect(await repository.insert(binding(tenantA, workspaceA))).toBeUndefined();

    expect(await repository.list(tenantB, workspaceA)).toEqual([]);
    expect(await repository.find(tenantB, workspaceA, stored!.id)).toBeUndefined();
    expect(await repository.delete(tenantB, workspaceA, stored!.id)).toBe(false);

    // Row-level security, not only the WHERE clause: tenant B's session sees none of tenant A's rows.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantB]);
      expect((await client.query("SELECT count(*)::int AS n FROM repository_bindings")).rows[0].n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'repository_bindings'`,
      [schemaName],
    );
    expect(columns.rows.map((row) => row.column_name).filter((name) => /token|secret/.test(name))).toEqual([]);

    expect(await repository.delete(tenantA, workspaceA, stored!.id)).toBe(true);
    expect(await repository.list(tenantA, workspaceA)).toEqual([]);
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
