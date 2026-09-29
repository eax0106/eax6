import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingRepository } from "./onboarding.repository";

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

// A saved onboarding step must be accepted when the caller holds the
// current version. updated_at carries microseconds and the caller's copy is
// a JS Date, so this is proven against real Postgres timestamps.
describe.skipIf(!databaseUrl)("OnboardingRepository save, PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let roleName: string;

  beforeEach(async () => {
    schemaName = `onboarding_save_${randomUUID().replaceAll("-", "_")}`;
    roleName = `onboarding_save_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    for (const statement of statements(["0000_platform_db_identity_foundation.sql", "0003_onboarding_states.sql"])) {
      await admin.query(statement);
    }
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
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

  it("saves against the version it read, and refuses a stale one", async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    await admin.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Onboarding Tenant', 'active')", [tenantId]);
    await admin.query("INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'Default', 'active')", [workspaceId, tenantId]);
    const repository = new OnboardingRepository(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await repository.initialize(tenantId, workspaceId, client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const current = await repository.find(tenantId, workspaceId);
    expect(current).not.toBeNull();
    const saved = await repository.save({ ...current!, status: "in_progress" }, current!.updatedAt);
    expect(saved).toMatchObject({ status: "in_progress" });

    await expect(repository.save({ ...current!, status: "completed" }, current!.updatedAt)).resolves.toBeNull();
  });
});
