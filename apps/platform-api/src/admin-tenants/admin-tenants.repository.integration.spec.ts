import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminTenantsRepository } from "./admin-tenants.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";

describe.skipIf(!databaseUrl)("AdminTenantsRepository PostgreSQL RLS", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: AdminTenantsRepository;
  let schemaName: string;
  let roleName: string;

  beforeEach(async () => {
    schemaName = `admin_tenants_${randomUUID().replaceAll("-", "_")}`;
    roleName = `admin_tenants_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES
       IN SCHEMA "${schemaName}" TO "${roleName}"`,
    );
    // Mirrors the migration's real grant to platform_api, scoped to the test role here.
    await admin.query(
      `GRANT EXECUTE ON FUNCTION "${schemaName}".admin_list_tenants() TO "${roleName}"`,
    );
    // In real deployment there's one schema ("public"), and every role has
    // implicit USAGE on it by default — so platform_provisioner (the
    // SECURITY DEFINER function's owner) can already resolve unqualified
    // table names there. This test's per-test dynamic schema breaks that
    // default, so USAGE must be granted explicitly here (test-only step,
    // not a migration gap).
    await admin.query(
      `GRANT USAGE ON SCHEMA "${schemaName}" TO platform_provisioner`,
    );
    await admin.query(
      `INSERT INTO staff_users (id, identity_ref, email, roles)
       VALUES ('stf_test', 'auth0|admin-tenants-test', 'ops@example.com', ARRAY['staff_admin'])`,
    );
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    repository = new AdminTenantsRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("appends immutable notes under the ordinary role and requires successful staff audit", async () => {
    const subjectId = randomUUID();
    await repository.createTenant(subjectId, "Notes tenant", "org-notes", "ap-south-1");
    const audit = vi.fn(async () => "acknowledged");
    const note = await repository.appendNote(subjectId, "stf_test", "Investigation completed", audit);
    expect(note).toMatchObject({action: "note_added", reason: "Investigation completed", staff_email: "ops@example.com"});
    expect(audit).toHaveBeenCalledExactlyOnceWith(note!.id);
    expect(note!.id).toMatch(/^taa_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await repository.listActions(subjectId)).toContainEqual(note);
    await expect(pool.query("UPDATE tenant_admin_actions SET reason='changed' WHERE id=$1", [note!.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM tenant_admin_actions WHERE id=$1", [note!.id])).rejects.toThrow(/append-only/);
    await expect(repository.appendNote(subjectId, "stf_test", "No audit acknowledgement", async () => {throw new Error("Audit unavailable");})).rejects.toThrow("Audit unavailable");
    expect(await repository.listActions(subjectId)).toEqual([note]);
    const missingAudit = vi.fn(async () => "acknowledged");
    expect(await repository.appendNote(randomUUID(), "stf_test", "Unknown subject", missingAudit)).toBeUndefined();
    expect(missingAudit).not.toHaveBeenCalled();
  });

  it("pairs rollback without deleting retained note history and restores note support on reapply", async () => {
    const migration = readFileSync(join(__dirname, "../db/migrations/0035_admin_notes.sql"), "utf8");
    const rollback = readFileSync(join(__dirname, "../db/migrations/rollback/0035_remove_admin_notes.sql"), "utf8");
    for (const sql of rollback.split("--> statement-breakpoint")) if (sql.trim()) await admin.query(sql);
    for (const sql of migration.split("--> statement-breakpoint")) if (sql.trim()) await admin.query(sql);
    const subjectId = randomUUID();
    await repository.createTenant(subjectId, "Rollback tenant", "org-rollback", "ap-south-1");
    const note = await repository.appendNote(subjectId, "stf_test", "Retained history", async () => "acknowledged");
    await expect(admin.query(rollback.split("--> statement-breakpoint")[0]!)).rejects.toThrow(/retained note history/);
    expect(await repository.listActions(subjectId)).toEqual([note]);
  });

  it("enforces bounded note bodies in PostgreSQL without changing existing action reasons", async () => {
    const subjectId = randomUUID();
    await repository.createTenant(subjectId, "Notes tenant", "org-notes", "ap-south-1");
    for (const body of ["", "   ", "a".repeat(4001)]) {
      await expect(repository.appendNote(subjectId, "stf_test", body, async () => "acknowledged")).rejects.toThrow(/notes_body_check/);
    }
    expect(await repository.listActions(subjectId)).toEqual([]);
  });

  it("defaults to zero rows under FORCE RLS with no tenant context set", async () => {
    const tenantId = randomUUID();
    await repository.createTenant(tenantId, "Direct-RLS Tenant", "org-ref", "ap-south-1");

    const client = await pool.connect();
    try {
      await client.query("RESET app.current_tenant_id");
      expect((await client.query("SELECT * FROM tenants")).rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("creates, finds, and suspends/reinstates a tenant scoped to its own id", async () => {
    const tenantId = randomUUID();
    const created = await repository.createTenant(
      tenantId,
      "Acme Corp",
      "org-acme",
      "ap-south-1",
    );
    expect(created.status).toBe("active");

    expect((await repository.find(tenantId))?.name).toBe("Acme Corp");

    const suspended = await repository.setStatus(tenantId, "suspended");
    expect(suspended?.status).toBe("suspended");

    const reinstated = await repository.setStatus(tenantId, "active");
    expect(reinstated?.status).toBe("active");
  });

  it("lists across tenants via the SECURITY DEFINER bypass despite FORCE RLS", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await repository.createTenant(tenantA, "Tenant A", "org-a", "ap-south-1");
    await repository.createTenant(tenantB, "Tenant B", "org-b", "ap-south-1");

    const listed = await repository.list();
    expect(listed.map((t) => t.id).sort()).toEqual([tenantA, tenantB].sort());
  });

  it("rolls back the transaction on a constraint violation", async () => {
    const tenantId = randomUUID();
    await repository.createTenant(tenantId, "First", "org-first", "ap-south-1");
    await expect(
      repository.createTenant(tenantId, "Duplicate id", "org-dup", "ap-south-1"),
    ).rejects.toThrow();
    expect((await repository.find(tenantId))?.name).toBe("First");
  });

  it("records and append-only-protects tenant admin actions", async () => {
    const tenantId = randomUUID();
    await repository.createTenant(tenantId, "Audited Tenant", "org-ref", "ap-south-1");
    await repository.recordAction(tenantId, "stf_test", "provisioned", null);
    await repository.recordAction(tenantId, "stf_test", "suspended", "abuse review");

    const rows = await admin.query<{ action: string; reason: string | null }>(
      `SELECT action, reason FROM tenant_admin_actions
       WHERE tenant_id = $1 ORDER BY occurred_at`,
      [tenantId],
    );
    expect(rows.rows).toEqual([
      { action: "provisioned", reason: null },
      { action: "suspended", reason: "abuse review" },
    ]);

    await expect(
      admin.query(
        `UPDATE tenant_admin_actions SET reason = 'tampered' WHERE tenant_id = $1`,
        [tenantId],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      admin.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow("append-only");
  });
});

async function applyMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  const sql = files
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n--> statement-breakpoint\n");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
}
