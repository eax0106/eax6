import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import { PlatformDeletionService } from "./platform-deletion.service";
import { PgErasureStore } from "./pg-erasure-store";
import { PLATFORM_DELETION_TOKEN_HASH, PlatformDeletionController } from "./platform-deletion.controller";

// D2 (Y1): tombstones past the 90-day window lose their retained staff
// access rows, manifests and themselves through the dedicated expiry
// function only. Real Postgres with the real migrations, through a
// non-owner role held to row security. Secrets are fake; nothing else is.
const databaseUrl = process.env.DATABASE_URL ?? "";
const OLD_TENANT = "00000000-0000-7000-8000-000000000e01";
const YOUNG_TENANT = "00000000-0000-7000-8000-000000000e02";
const LIVE_TENANT = "00000000-0000-7000-8000-000000000e03";
const STAFF = "stf_expiry_test";
const OLD_USER = "00000000-0000-7000-8000-000000000e11";
const FRESH_USER = "00000000-0000-7000-8000-000000000e12";
const LIVE_USER = "00000000-0000-7000-8000-000000000e13";

async function expectDeleteToRaise(query: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await query;
  } catch (error: unknown) {
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  expect.unreachable("direct delete resolved instead of raising");
}describe.skipIf(!databaseUrl)("Retention tombstone expiry (Y1)", () => {  let admin: pg.Client;
  let pool: pg.Pool;
  let retentionPool: pg.Pool;
  let schemaName: string;
  let roleName: string;
  let retentionRole: string;
  let service: PlatformDeletionService;

  async function count(table: string, column: string, value: string): Promise<number> {
    const rows = await admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${column} = $1`, [value]);
    return (rows.rows[0] as { n: number }).n;
  }

  beforeEach(async () => {
    schemaName = `expiry_${randomUUID().replaceAll("-", "_")}`;
    roleName = `expiry_role_${randomUUID().replaceAll("-", "_")}`;
    retentionRole = `expiry_retention_${randomUUID().replaceAll("-", "_")}`;
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
    await admin.query(`INSERT INTO staff_users (id, identity_ref, email, roles) VALUES ('${STAFF}', 'check|${STAFF}', 'staff@example.test', ARRAY['staff_admin'])`);
    // Tombstones: exactly 90 days goes, 89 days 23 hours survives.
    await admin.query(`INSERT INTO tenants (id, name, status, deleted_at) VALUES ($1, 'old', 'deleted', transaction_timestamp() - interval '90 days')`, [OLD_TENANT]);
    await admin.query(`INSERT INTO tenants (id, name, status, deleted_at) VALUES ($1, 'young', 'deleted', transaction_timestamp() - interval '89 days 23 hours')`, [YOUNG_TENANT]);
    await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'live', 'active')`, [LIVE_TENANT]);
    for (const tenant of [OLD_TENANT, YOUNG_TENANT, LIVE_TENANT]) {
      const tag = tenant.slice(-4);
      await admin.query(
        `INSERT INTO tenant_admin_actions (id, tenant_id, staff_user_id, action, reason) VALUES ('taa_${tag}', $1, '${STAFF}', 'note_added', 'Retained staff note')`,
        [tenant],
      );
      await admin.query(
        `INSERT INTO jit_grants (id, staff_user_id, tenant_id, reason_code, reason_text, granted_at, expires_at) VALUES ('jit_${tag}', '${STAFF}', $1, 'test', 'test', now() - interval '91 days', now() + interval '1 day')`,
        [tenant],
      );
      await admin.query(`INSERT INTO jit_grant_audit (id, jit_grant_id, action, actor_id) VALUES ('jta_${tag}', 'jit_${tag}', 'granted', '${STAFF}')`);
      await admin.query(
        `INSERT INTO tenant_erasure_manifests (manifest_id, tenant_id, state) VALUES ('del_00000000-0000-7000-8000-00000000${tag.slice(-4)}', $1, 'complete')`,
        [tenant],
      );
    }
    // Users: an old pseudonymised orphan (expiry takes its actions), a fresh
    // orphan (kept: nothing anchors it past the window yet) and a live member.
    for (const [user, member] of [[OLD_USER, false], [FRESH_USER, false], [LIVE_USER, true]] as [string, boolean][]) {
      // The old orphan's updated_at is pinned at erasure time on INSERT:
      // the users_set_updated_at trigger would clobber a backdated UPDATE.
      const aged = user === OLD_USER ? `transaction_timestamp() - interval '90 days'` : `transaction_timestamp()`;
      await admin.query(
        `INSERT INTO users (id, identity_ref, email, display_name, status, updated_at) VALUES ($1::uuid, 'erased:' || $1::text, 'erased-' || $1::text || '@erased.invalid', NULL, 'suspended', ${aged})`,
        [user],
      );
      await admin.query(`INSERT INTO user_admin_actions (id, user_id, staff_user_id, action, reason) VALUES ('uaa_${user.slice(-4)}', $1, '${STAFF}', 'note_added', 'Retained staff note')`, [user]);
      if (member) {
        await admin.query(`INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'member')`, [LIVE_TENANT, user]);
      }
    }
    await admin.query("UPDATE tenant_erasure_manifests SET retained_user_ids = $2::uuid[] WHERE tenant_id = $1", [OLD_TENANT, [OLD_USER]]);

    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`REVOKE ALL ON FUNCTION "${schemaName}".expire_erasure_skeleton(timestamptz) FROM "${roleName}"`);
    await admin.query(`CREATE ROLE "${retentionRole}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT platform_retention TO "${retentionRole}"`);
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    url.username = retentionRole;
    retentionPool = new pg.Pool({ connectionString: url.toString() });
    const secrets = { getSecret: async () => { throw new Error("no secrets in this spec"); } };
    service = new PlatformDeletionService(new PgErasureStore(pool), secrets as unknown as MutableSecretsProvider, new PgErasureStore(retentionPool));
  });

  afterEach(async () => {
    await pool?.end().catch(() => undefined);
    await retentionPool?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.query(`DROP ROLE IF EXISTS "${retentionRole}"`);
      await admin.end();
    }
  });

  it("holds the session to row security", async () => {
    const roles = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("requires the dedicated retention connection without giving it table access", async () => {
    await expect(pool.query("SELECT expire_erasure_skeleton(NULL)")).rejects.toThrow(/permission denied/);
    await expect(retentionPool.query("DELETE FROM tenant_admin_actions")).rejects.toThrow(/permission denied/);
    await expect(retentionPool.query("SELECT * FROM tenants")).rejects.toThrow(/permission denied/);
    expect((await retentionPool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect((await retentionPool.query("SELECT expire_erasure_skeleton(NULL) AS n")).rows).toEqual([{ n: 0 }]);
  });

  it("retains old user actions without a tenant deletion anchor", async () => {
    await admin.query("UPDATE tenant_erasure_manifests SET retained_user_ids = '{}' WHERE tenant_id = $1", [OLD_TENANT]);
    await service.applyRetentionPolicy();
    expect(await count("user_admin_actions", "user_id", OLD_USER)).toBe(1);
  });

  it("retains anchored user actions when another tenant still has a membership", async () => {
    await admin.query("INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'member')", [LIVE_TENANT, OLD_USER]);
    await service.applyRetentionPolicy();
    expect(await count("user_admin_actions", "user_id", OLD_USER)).toBe(1);
  });

  it("refuses direct deletes of skeleton rows, manifests and tombstones", async () => {
    // Trigger-guarded tables (no row security): the delete reaches the
    // guard and raises, whatever the session's tenant context.
    await expectDeleteToRaise(
      pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = $1`, [OLD_TENANT]),
      /append-only/,
    );
    await expectDeleteToRaise(pool.query(`DELETE FROM jit_grant_audit WHERE id = 'jta_0e01'`), /append-only/);
    await expectDeleteToRaise(
      pool.query(`DELETE FROM tenant_erasure_manifests WHERE tenant_id = $1`, [OLD_TENANT]),
      /except on expiry/,
    );
    // Tombstones are row-secured: a contextless session sees nothing and
    // deletes nothing...
    const hidden = await pool.query(`DELETE FROM tenants WHERE id = $1`, [OLD_TENANT]);
    expect(hidden.rowCount).toBe(0);
    expect(await count("tenants", "id", OLD_TENANT)).toBe(1);
    // ...and a session that names the victim tenant meets the guard. A
    // dedicated connection: set_config binds the session, not the pool.
    const scoped = await pool.connect();
    try {
      await scoped.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [OLD_TENANT]);
      await expectDeleteToRaise(scoped.query(`DELETE FROM tenants WHERE id = $1`, [OLD_TENANT]), /except on expiry/);
    } finally {
      scoped.release();
    }
    // Untouched by the refusals: everything is still there.
    expect(await count("tenant_admin_actions", "tenant_id", OLD_TENANT)).toBe(1);
    expect(await count("tenants", "id", OLD_TENANT)).toBe(1);
  });

  it("expires the 90-day tombstone with its rows and manifest, and keeps the rest", async () => {
    const sweep = await service.applyRetentionPolicy();
    expect(sweep.store).toBe("platform-api");
    // Old tenant: skeleton rows (3 tenant-linked + audit + orphan user action),
    // manifest and tombstone gone.
    expect(await count("tenant_admin_actions", "tenant_id", OLD_TENANT)).toBe(0);
    expect(await count("jit_grants", "tenant_id", OLD_TENANT)).toBe(0);
    expect(await count("jit_grant_audit", "id", "jta_0e01")).toBe(0);
    expect(await count("user_admin_actions", "user_id", OLD_USER)).toBe(0);
    expect(await count("tenant_erasure_manifests", "tenant_id", OLD_TENANT)).toBe(0);
    expect(await count("tenants", "id", OLD_TENANT)).toBe(0);
    // Young tenant (89d23h): everything survives.
    expect(await count("tenant_admin_actions", "tenant_id", YOUNG_TENANT)).toBe(1);
    expect(await count("tenant_erasure_manifests", "tenant_id", YOUNG_TENANT)).toBe(1);
    expect(await count("tenants", "id", YOUNG_TENANT)).toBe(1);
    // Fresh orphan's actions survive (no 90-day anchor); live tenant untouched.
    expect(await count("user_admin_actions", "user_id", FRESH_USER)).toBe(1);
    expect(await count("tenant_admin_actions", "tenant_id", LIVE_TENANT)).toBe(1);
    expect(await count("tenants", "id", LIVE_TENANT)).toBe(1);
    expect(sweep.deletedRows).toBe(6);
  });

  it("expires through listening HTTP with the credential and dedicated database role", async () => {
    const token = randomUUID();
    const module = await Test.createTestingModule({ controllers: [PlatformDeletionController], providers: [
      { provide: PlatformDeletionService, useValue: service },
      { provide: PLATFORM_DELETION_TOKEN_HASH, useValue: createHash("sha256").update(token).digest("hex") },
    ] }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    try {
      await app.listen(0, "127.0.0.1");
      const endpoint = `${await app.getUrl()}/internal/deletion/retention`;
      const observed = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/testing/probe-platform-retention.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) { reject(new Error("Retention socket probe failed")); return; }
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({ endpoint, token }));
      });
      expect(observed).toMatchObject({ missing: 401, wrong: 401, accepted: 201,
        body: { deletedRows: 6, deletedObjects: 0, store: "platform-api" } });
      expect(await count("tenants", "id", OLD_TENANT)).toBe(0);
      expect(await count("tenants", "id", YOUNG_TENANT)).toBe(1);
      expect(await count("tenants", "id", LIVE_TENANT)).toBe(1);
    } finally { await app.close(); }
  });
});
