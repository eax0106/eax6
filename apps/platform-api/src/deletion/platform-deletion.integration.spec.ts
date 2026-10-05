import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import { applyMarketplaceMigrations } from "../db/marketplace-migrator";
import { PgErasureStore } from "./pg-erasure-store";
import { PLATFORM_DELETE_ORDER, PlatformDeletionService, PLATFORM_TABLES, pseudonymOf } from "./platform-deletion.service";
import { SKELETON_TABLES } from "./retention-config";
import { PlatformDeletionController, PLATFORM_DELETION_TOKEN_HASH } from "./platform-deletion.controller";

// D2 (C3b): erasing a tenant from platform_db, against real Postgres with the real
// migrations, through a non-owner role held to row security, exactly as production
// connects. Nothing here is mocked except the secrets store.
const databaseUrl = process.env.DATABASE_URL ?? "";
const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000b1";
const ten = (id: string) => `ten_${id}`;
const MANIFEST = "del_00000000-0000-7000-8000-00000000d001";
const wsA = "00000000-0000-7000-8000-00000000a101";
const wsB = "00000000-0000-7000-8000-00000000b101";
const u1 = "00000000-0000-7000-8000-000000000101"; // only tenant A
const u2 = "00000000-0000-7000-8000-000000000102"; // tenants A and B
const u3 = "00000000-0000-7000-8000-000000000103"; // only tenant B

class FakeSecrets {
  readonly values = new Map<string, string>();
  async getSecret(reference: string) {
    const value = this.values.get(reference);
    if (value === undefined) throw Object.assign(new Error("not found"), { name: "SecretNotFoundError" });
    return value;
  }
  async putSecret(reference: string, value: string) {
    this.values.set(reference, value);
  }
  async deleteSecret(reference: string) {
    if (!this.values.delete(reference)) throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
  }
}

describe.skipIf(!databaseUrl)("PlatformDeletionService on PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let roleName: string;
  let secrets: FakeSecrets;
  let service: PlatformDeletionService;

  const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows[0]!;
  const count = async (table: string, tenantColumn = "tenant_id", tenant = A) =>
    Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE ${tenantColumn} = $1`, [tenant])).n);

  beforeEach(async () => {
    schemaName = `erase_${randomUUID().replaceAll("-", "_")}`;
    roleName = `erase_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}", public`);
    await applyMainMigrations(admin);
    await applyMarketplaceMigrations(admin);
    await seed();

    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    secrets = new FakeSecrets();
    for (const reference of [
      `/alter/credentials/${A}/00000000-0000-7000-8000-0000000c0001`,
      `/alter/env-vars/${A}/00000000-0000-7000-8000-0000000e0001`,
      `/alter/integrations/${A}/${wsA}/00000000-0000-7000-8000-000000050001`,
      `/alter/credentials/${B}/00000000-0000-7000-8000-0000000c0002`,
    ]) {
      secrets.values.set(reference, "s3cret");
    }
    service = new PlatformDeletionService(new PgErasureStore(pool), secrets as unknown as MutableSecretsProvider, new PgErasureStore(pool));
  }, 60_000);

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  }, 60_000);

  async function seed(): Promise<void> {
    const q = (sql: string, values: unknown[] = []) => admin.query(sql, values);
    for (const [id, name] of [[A, "Acme"], [B, "Bravo"]] as const) {
      await q(`INSERT INTO tenants (id, name, status, identity_org_ref, sso_config) VALUES ($1, $2, 'active', 'org_${name}', '{"x":1}')`, [id, name]);
    }
    await q(`INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'A', 'active'), ($3, $4, 'B', 'active')`, [wsA, A, wsB, B]);
    for (const [id, email] of [[u1, "one@example.test"], [u2, "two@example.test"], [u3, "three@example.test"]] as const) {
      await q(`INSERT INTO users (id, identity_ref, email, display_name, status) VALUES ($1, $2, $3, 'Real Name', 'active')`, [id, `auth0|${id}`, email]);
    }
    for (const [tenant, ws, user, role] of [[A, wsA, u1, "admin"], [A, wsA, u2, "editor"], [B, wsB, u2, "admin"], [B, wsB, u3, "editor"]] as const) {
      await q(`INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [randomUUID(), tenant, user]);
      await q(`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), tenant, ws, user, role]);
    }
    // Every invitation lifecycle state is tenant data, including accepted history.
    for (const [tenant, ws, user] of [[A, wsA, u1], [B, wsB, u3]] as const) {
      for (const status of ["pending", "accepted", "revoked", "delivery_failed"]) {
        await q(`INSERT INTO workspace_invitations
          (id,tenant_id,workspace_id,email,role,status,invited_by,provider_org_ref,provider_invitation_id,provider_ticket_hash,accepted_by,accepted_at)
          VALUES (gen_random_uuid(),$1,$2,$3,'viewer',$4,$5,'org_erasure',$6,$7,$5,now())`,
        [tenant, ws, `${status}@erasure.test`, status, user, randomUUID(), createHash("sha256").update(tenant + status).digest("hex")]);
      }
    }
    await q(`INSERT INTO user_sessions (id, user_id, tenant_id, refresh_token_hash, access_token_hash) VALUES ($1, $2, $3, 'r', 'a')`, [randomUUID(), u1, A]);
    // notifications
    for (const [tenant, ws, user] of [[A, wsA, u1], [B, wsB, u3]] as const) {
      const id = `evt_00000000-0000-7000-8000-${tenant === A ? "0000000000a1" : "0000000000b1"}`;
      await q(`INSERT INTO notification_events (id, tenant_id, workspace_id, event_class, severity, title, body, source_service) VALUES ($1, $2, $3, 'system', 'info', 't', 'b', 's')`, [id, tenant, ws]);
      await q(`INSERT INTO notification_reads (id, tenant_id, notification_event_id, user_id) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenant, id, user]);
    }
    // secrets-backed rows
    await q(`INSERT INTO credential_refs (tenant_id, id, name, connector, scope, last4) VALUES ($1, '00000000-0000-7000-8000-0000000c0001', 'k', 'github', 'workspace', '1234'), ($2, '00000000-0000-7000-8000-0000000c0002', 'k', 'github', 'workspace', '1234')`, [A, B]);
    await q(`INSERT INTO env_vars (tenant_id, id, project_id, environment, key, last4) VALUES ($1, '00000000-0000-7000-8000-0000000e0001', 'prj_1', 'production', 'K', '1234')`, [A]);
    await q(`INSERT INTO oauth_connections (tenant_id, id, workspace_id, connector, external_account_id, scopes) VALUES ($1, '00000000-0000-7000-8000-000000050001', $2, 'github', 'x', 'repo')`, [A, wsA]);
    await q(`INSERT INTO onboarding_states (id, tenant_id, workspace_id, steps, status) VALUES ($1, $2, $3, '{}', 'in_progress')`, [randomUUID(), A, wsA]);
    await q(`INSERT INTO entitlements (id, tenant_id, plan) VALUES ($1, $2, 'free')`, [randomUUID(), A]);
    for (const [tenant,user] of [[A,u1],[B,u3]] as const) {
      await q("INSERT INTO billing_policy_state(tenant_id,email_verified,verified_by) VALUES($1,true,$2)", [tenant,user]);
      await q("INSERT INTO billing_credit_deliveries(tenant_id,payment_ref,credits,provider_event_id) VALUES($1,'pay_erasure',100,'event_erasure')", [tenant]);
      await q(`INSERT INTO billing_subscription_plans(tenant_id,subscription_ref,provider_plan_ref,internal_plan,commercial_snapshot)
        VALUES($1,'sub_erasure','plan_erasure','paid',$2::jsonb)`, [tenant,JSON.stringify({currency:"INR",basePriceMinor:100,razorpayPlanId:"plan_erasure",includedCredits:100,extraCreditPriceMinor:10,creditsPerVerifiedRun:2})]);
    }
    // circular: tenants.billing_profile_id <-> billing_profiles.tenant_id
    const profile = randomUUID();
    await q(`INSERT INTO billing_profiles (tenant_id, id, provider_id, status) VALUES ($1, $2, 'razorpay', 'active')`, [A, profile]);
    await q(`UPDATE tenants SET billing_profile_id = $2 WHERE id = $1`, [A, profile]);
    await q(`INSERT INTO billing_events (tenant_id, provider_id, provider_event_id, type, payload) VALUES ($1, 'razorpay', 'evt_1', 'invoice.paid', '{"card":"4111111111111111"}')`, [A]);
    // append-only
    await q(`INSERT INTO action_item_annotations (id, tenant_id, item_type, item_id, note, created_by) VALUES ('ain_1', $1, 'approval', 'apr_1', 'private note', 'u')`, [A]);
    // marketplace: what the law keeps
    await q(`INSERT INTO publishers (id, tenant_id, verification_status) VALUES ('pub_1', $1, 'verified'), ('pub_2', $2, 'verified')`, [A, B]);
    await q(`INSERT INTO kyc_submissions (id, tenant_id, publisher_id, documents_json, status) VALUES ('kyc_1', $1, 'pub_1', '{"pan":"ABCDE1234F"}', 'approved')`, [A]);
    await q(`INSERT INTO listings (id, tenant_id, type, name, license_type, status) VALUES ('lst_1', '${A}', 'agent', 'L', 'tenant_wide', 'draft'), ('lst_2', '${A}', 'agent', 'Own', 'tenant_wide', 'draft')`);
    await q(`INSERT INTO listing_versions (id, listing_id, version, payload_ref, compatibility_json) VALUES ('lsv_2', 'lst_2', '1.0.0', 'ref', '{}')`);
    await q(`INSERT INTO listing_versions (id, listing_id, version, payload_ref, compatibility_json) VALUES ('lsv_1', 'lst_1', '1.0.0', 'ref', '{}')`);
    await q(`INSERT INTO orders (id, tenant_id, listing_id, listing_version_id, amount_minor, currency, status, idempotency_key) VALUES ('ord_1', $1, 'lst_1', 'lsv_1', 5000, 'INR', 'paid', 'k1'), ('ord_2', $2, 'lst_1', 'lsv_1', 7000, 'INR', 'paid', 'k2')`, [A, B]);
    await q(`INSERT INTO payouts (id, tenant_id, order_id, publisher_id, total_minor, seller_share_minor, platform_share_minor, status) VALUES ('pay_1', $1, 'ord_1', 'pub_1', 5000, 4000, 1000, 'processed')`, [A]);
    await q(`INSERT INTO payout_ledger (id, tenant_id, payout_id, entry_type, amount_minor) VALUES ('led_1', $1, 'pay_1', 'payout_created', 4000)`, [A]);
    await q(`INSERT INTO marketplace_governance_events(id,tenant_id,resource_type,resource_id,actor_type,actor_ref,action,previous_status,next_status,reason,resource_revision)
      VALUES ('mge_00000000-0000-7000-8000-000000009001',$1,'listing','lst_1','staff','stf_1','needs_changes','human_review','needs_changes','Correct fields',1)`,[A]);
    // staff access records: kept 90 days
    await q(`INSERT INTO staff_users (id, identity_ref, email, roles) VALUES ('stf_1', 'auth0|s', 's@example.test', ARRAY['staff_support'])`);
    await q(`INSERT INTO tenant_admin_actions (id, tenant_id, staff_user_id, action, reason) VALUES ('taa_1', $1, 'stf_1', 'note_added', 'Retained staff note')`, [A]);
    await q(`INSERT INTO user_admin_actions (id, user_id, staff_user_id, action, reason) VALUES ('uaa_1', $1, 'stf_1', 'note_added', 'Retained staff note')`, [u1]);
  }

  it("names every table exactly once between the delete order and the special cases", () => {
    const special = ["action_item_annotations", "payout_ledger", "marketplace_governance_events", "listings", "listing_versions", "tenants", "users", ...SKELETON_TABLES];
    expect([...PLATFORM_DELETE_ORDER, ...special].sort()).toEqual([...PLATFORM_TABLES].sort());
    expect(new Set(PLATFORM_DELETE_ORDER).size).toBe(PLATFORM_DELETE_ORDER.length);
  });

  it("expires legal holds exactly at the database clock and preserves records one second before expiry, tenants and staff records", async () => {
    const store = new PgErasureStore(pool);
    await store.withoutTenant(async (tx) => {
      await tx.query(`INSERT INTO legal_hold_records (tenant_pseudonym, kind, source_table, source_id, minimal, retain_until)
        VALUES ('pseudo', 'tax_invoice', 'billing_events', 'expired', '{}', transaction_timestamp() - interval '1 second'),
               ('pseudo', 'tax_invoice', 'billing_events', 'exact', '{}', transaction_timestamp()),
               ('pseudo', 'tax_invoice', 'billing_events', 'unexpired', '{}', transaction_timestamp() + interval '1 second')`);
      const sameTransactionService = new PlatformDeletionService({
        withTenant: store.withTenant.bind(store), withoutTenant: async (operation) => operation(tx),
      }, secrets as unknown as MutableSecretsProvider, { withTenant: store.withTenant.bind(store), withoutTenant: async (operation) => operation(tx) });
      expect(await sameTransactionService.applyRetentionPolicy()).toMatchObject({ deletedRows: 2, deletedObjects: 0, store: "platform-api" });
      expect((await tx.query("SELECT source_id FROM legal_hold_records ORDER BY source_id")).rows).toEqual([{ source_id: "unexpired" }]);
      expect(await sameTransactionService.applyRetentionPolicy()).toMatchObject({ deletedRows: 0 });
    });
    expect(await count("tenants", "id")).toBe(1);
    expect(await count("tenant_admin_actions")).toBe(1);
    expect(await count("workspaces")).toBe(1);
    expect(await count("tenants", "id", B)).toBe(1);
  });

  it("sweeps through the listening internal route only with the configured shared credential", async () => {
    await admin.query(`INSERT INTO legal_hold_records (tenant_pseudonym, kind, source_table, source_id, minimal, retain_until)
      VALUES ('pseudo', 'seller_kyc', 'kyc_submissions', 'expired-http', '{}', now() - interval '1 second')`);
    const token = randomUUID();
    const module = await Test.createTestingModule({
      controllers: [PlatformDeletionController], providers: [
        { provide: PlatformDeletionService, useValue: service },
        { provide: PLATFORM_DELETION_TOKEN_HASH, useValue: createHash("sha256").update(token).digest("hex") },
      ],
    }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    try {
      await app.listen(0, "127.0.0.1");
      const endpoint = `${await app.getUrl()}/internal/deletion/retention`;
      const observed = await new Promise<{ missing: number; wrong: number; accepted: number; body: unknown }>((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/testing/probe-platform-retention.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) { reject(new Error("Platform retention socket probe failed")); return; }
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({ endpoint, token }));
      });
      expect(observed).toMatchObject({ missing: 401, wrong: 401, accepted: 201 });
      expect(observed.body).toMatchObject({ store: "platform-api", deletedRows: 1, deletedObjects: 0 });
      expect((await admin.query("SELECT source_id FROM legal_hold_records")).rows).toEqual([]);
      expect(await count("tenants", "id")).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("finds tenant A's data in every table it is answerable for, and none of tenant B's", async () => {
    const located = await service.locateSubjectData(ten(A));
    expect(located.map((item) => item.table).sort()).toEqual([...PLATFORM_TABLES].sort());
    const rows = Object.fromEntries(located.map((item) => [item.table, item.rowCount]));
    expect(rows).toMatchObject({ tenants: 1, users: 2, payout_ledger: 1, action_item_annotations: 1, orders: 1, workspaces: 1, workspace_invitations: 4, billing_policy_state: 1, billing_credit_deliveries: 1, billing_subscription_plans: 1 });
  });

  it("erases tenant A completely, leaves tenant B whole, and verification agrees", async () => {
    const result = await service.deleteSubjectData(ten(A), MANIFEST);
    const verified = await service.verifyDeletion(ten(A), MANIFEST);

    expect(result.deletedRows).toBeGreaterThan(0);
    expect(result.deletedObjects).toBe(3); // credential, env var, connection: tenant A's own secrets
    expect(verified).toMatchObject({ deleted: true, remaining: [] });
    for (const table of ["billing_policy_state", "billing_credit_deliveries", "billing_subscription_plans", "workspace_invitations", "workspaces", "tenant_members", "workspace_members", "user_sessions", "notification_events", "notification_reads", "credential_refs", "env_vars", "oauth_connections", "onboarding_states", "entitlements", "billing_profiles", "billing_events", "marketplace_governance_events", "action_item_annotations", "kyc_submissions", "orders", "payouts", "payout_ledger", "publishers"]) {
      expect(await count(table), table).toBe(0);
    }
    for (const table of ["billing_policy_state", "billing_credit_deliveries", "billing_subscription_plans"]) expect(await count(table,"tenant_id",B),table).toBe(1);
    // tenant B is untouched
    expect(await count("workspace_invitations", "tenant_id", B)).toBe(4);
    expect(await count("workspaces", "tenant_id", B)).toBe(1);
    expect(await count("credential_refs", "tenant_id", B)).toBe(1);
    expect(await count("orders", "tenant_id", B)).toBe(1);
    // B's order depends on A's listing: kept, ownerless and blank. A's other listing is gone.
    expect(await one("SELECT tenant_id, name, status FROM listings WHERE id = 'lst_1'")).toEqual({ tenant_id: null, name: "[removed listing]", status: "removed" });
    expect((await admin.query("SELECT id FROM listings WHERE id = 'lst_2'")).rowCount).toBe(0);
    expect((await admin.query("SELECT id FROM listing_versions WHERE id = 'lsv_2'")).rowCount).toBe(0);
    expect(await count("notification_events", "tenant_id", B)).toBe(1);
    expect(secrets.values.has(`/alter/credentials/${B}/00000000-0000-7000-8000-0000000c0002`)).toBe(true);
    expect([...secrets.values.keys()].filter((key) => key.includes(`/${A}/`))).toEqual([]);
  });

  it("leaves a tombstone: the id and deleted_at, nothing else", async () => {
    await service.deleteSubjectData(ten(A), MANIFEST);
    const row = await one<Record<string, unknown>>("SELECT * FROM tenants WHERE id = $1", [A]);
    expect(row).toMatchObject({
      id: A,
      name: "",
      status: "deleted",
      identity_org_ref: null,
      data_residency: null,
      security_policy: null,
      sso_config: null,
      billing_profile_id: null,
    });
    expect(row.deleted_at).toBeInstanceOf(Date);
  });

  it("keeps the staff access records for the 90-day window, and pseudonymises members nobody else holds", async () => {
    await service.deleteSubjectData(ten(A), MANIFEST);
    expect(await count("tenant_admin_actions")).toBe(1);
    expect(await count("user_admin_actions", "user_id", u1)).toBe(1);

    const rows = Object.fromEntries((await admin.query<{ id: string; email: string; display_name: string | null; status: string }>("SELECT id, email, display_name, status FROM users")).rows.map((row) => [row.id, row]));
    expect(rows[u1]).toMatchObject({ email: `erased-${u1}@erased.invalid`, display_name: null, status: "suspended" });
    expect(rows[u2]).toMatchObject({ email: "two@example.test", display_name: "Real Name", status: "active" }); // still in tenant B
    expect(rows[u3]).toMatchObject({ email: "three@example.test", status: "active" });
  });

  it("copies to the legal-hold store only the minimum the law keeps, with no tenant reference", async () => {
    expect((await admin.query("SELECT payload FROM billing_events WHERE tenant_id = $1", [A])).rows)
      .toEqual([{ payload: { card: "4111111111111111" } }]);
    await service.deleteSubjectData(ten(A), MANIFEST);
    const held = (await admin.query<{ kind: string; source_table: string; source_id: string; minimal: Record<string, unknown>; tenant_pseudonym: string; retain_until: Date; held_at: Date }>("SELECT * FROM legal_hold_records ORDER BY source_table")).rows;

    expect(held.map((row) => `${row.source_table}:${row.kind}`)).toEqual([
      "billing_events:tax_invoice",
      "kyc_submissions:seller_kyc",
      "orders:books_of_account",
      "payout_ledger:seller_payout",
      "payouts:seller_payout",
    ]);
    expect(new Set(held.map((row) => row.tenant_pseudonym))).toEqual(new Set([pseudonymOf(ten(A))]));
    const kyc = held.find((row) => row.source_table === "kyc_submissions")!;
    expect(kyc.minimal).toEqual({ id: "kyc_1", publisher_id: "pub_1", status: "approved", submitted_at: expect.anything(), reviewed_at: null });
    expect(JSON.stringify(held)).not.toMatch(/ABCDE1234F|4111111111111111|private note/);
    const years = (row: (typeof held)[number]) => (row.retain_until.getTime() - row.held_at.getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(Math.round(years(held.find((row) => row.source_table === "orders")!))).toBe(8);
    expect(Math.round(years(held.find((row) => row.source_table === "billing_events")!))).toBe(6);
    expect(Math.round(years(held.find((row) => row.source_table === "payouts")!))).toBe(5);
    const columns = (await admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'legal_hold_records'", [schemaName])).rows.map((row) => row.column_name);
    expect(columns).not.toContain("tenant_id");
  });

  it("can be run again with the same manifest, or a new one, without harm", async () => {
    await service.deleteSubjectData(ten(A), MANIFEST);
    const again = await service.deleteSubjectData(ten(A), MANIFEST);
    const replay = await service.deleteSubjectData(ten(A), "del_00000000-0000-7000-8000-00000000d002");
    expect(again.deletedRows).toBe(0);
    expect(replay.deletedObjects).toBe(0);
    expect(await service.verifyDeletion(ten(A), MANIFEST)).toMatchObject({ deleted: true });
    expect(Number((await one<{ n: string }>("SELECT count(*)::text AS n FROM legal_hold_records")).n)).toBe(5);
  });

  it("verification fails while a tenant secret still exists in the secrets store", async () => {
    await service.deleteSubjectData(ten(A), MANIFEST);
    secrets.values.set(`/alter/credentials/${A}/00000000-0000-7000-8000-0000000c0001`, "came back");
    const verified = await service.verifyDeletion(ten(A), MANIFEST);
    expect(verified.deleted).toBe(false);
    expect(verified.remaining).toEqual([expect.objectContaining({ table: "secrets-store", rowCount: 1 })]);
  });

  it("does not delete a secret before the erasure is committed", async () => {
    const failing = new PlatformDeletionService(new PgErasureStore(pool), secrets as unknown as MutableSecretsProvider);
    await admin.query("CREATE OR REPLACE FUNCTION erase_tenant_action_annotations(p_tenant uuid, p_manifest text) RETURNS integer LANGUAGE sql AS $$ SELECT 1/0 $$");
    await expect(failing.deleteSubjectData(ten(A), MANIFEST)).rejects.toThrow();
    expect(secrets.values.size).toBe(4);
    expect(await count("credential_refs")).toBe(1);
  });

  describe("the append-only guards", () => {
    it("a normal application session cannot delete an annotation, even naming its own tenant and with a manifest", async () => {
      await admin.query(`INSERT INTO tenant_erasure_manifests (manifest_id, tenant_id) VALUES ($1, $2)`, [MANIFEST, A]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
        await client.query("SELECT set_config('alter.erasing_tenant', $1, true)", [A]);
        await expect(client.query("DELETE FROM action_item_annotations WHERE tenant_id = $1", [A])).rejects.toThrow("append-only");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(await count("action_item_annotations")).toBe(1);
    });

    it("a normal application session cannot delete a payout ledger row either", async () => {
      await admin.query(`INSERT INTO tenant_erasure_manifests (manifest_id, tenant_id) VALUES ($1, $2)`, [MANIFEST, A]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
        await client.query("SAVEPOINT s");
        await expect(client.query("DELETE FROM payout_ledger WHERE tenant_id = $1", [A])).rejects.toThrow("append-only");
        await client.query("ROLLBACK TO SAVEPOINT s");
        await expect(client.query("UPDATE payout_ledger SET amount_minor = 1")).rejects.toThrow("append-only");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(await count("payout_ledger")).toBe(1);
    });

    it("the erase functions refuse without an active manifest for that very tenant", async () => {
      const call = (fn: string, tenant: string, manifest: string) =>
        pool.query(`SELECT ${fn}($1::uuid, $2)`, [tenant, manifest]);
      await expect(call("erase_tenant_action_annotations", A, MANIFEST)).rejects.toThrow("no active erasure manifest");
      await admin.query(`INSERT INTO tenant_erasure_manifests (manifest_id, tenant_id) VALUES ($1, $2)`, [MANIFEST, B]);
      await expect(call("erase_tenant_action_annotations", A, MANIFEST)).rejects.toThrow("no active erasure manifest");
      await expect(call("erase_tenant_payout_ledger", A, MANIFEST)).rejects.toThrow("no active erasure manifest");
      await expect(call("erase_tenant_marketplace_governance", A, MANIFEST)).rejects.toThrow("no active erasure manifest");
      expect(await count("action_item_annotations")).toBe(1);
      expect(await count("payout_ledger")).toBe(1);
    });

    it("the erase function deletes only the named tenant's rows", async () => {
      await admin.query(`INSERT INTO action_item_annotations (id, tenant_id, item_type, item_id, note, created_by) VALUES ('ain_b', $1, 'approval', 'apr_b', 'n', 'u')`, [B]);
      await admin.query(`INSERT INTO tenant_erasure_manifests (manifest_id, tenant_id) VALUES ($1, $2)`, [MANIFEST, A]);
      const result = await pool.query<{ n: number }>("SELECT erase_tenant_action_annotations($1::uuid, $2) AS n", [A, MANIFEST]);
      expect(result.rows[0]!.n).toBe(1);
      expect(await count("action_item_annotations", "tenant_id", B)).toBe(1);
    });

    it("erases governance reasons only through its dedicated function and preserves the other tenant",async()=>{
      await admin.query(`INSERT INTO marketplace_governance_events(id,tenant_id,resource_type,resource_id,actor_type,actor_ref,action,previous_status,next_status,reason,resource_revision)
        VALUES('mge_00000000-0000-7000-8000-000000009002',$1,'listing','lst_other','staff','stf_1','needs_changes','human_review','needs_changes','Other seller reason',1)`,[B]);
      await admin.query("INSERT INTO tenant_erasure_manifests(manifest_id,tenant_id) VALUES($1,$2)",[MANIFEST,A]);
      const client=await pool.connect();try{
        await client.query("BEGIN");await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
        expect((await client.query("DELETE FROM marketplace_governance_events WHERE tenant_id=$1",[A])).rowCount).toBe(0);
        expect((await client.query("UPDATE marketplace_governance_events SET reason='Modified' WHERE tenant_id=$1",[A])).rowCount).toBe(0);
      }finally{await client.query("ROLLBACK");client.release();}
      expect((await pool.query("SELECT erase_tenant_marketplace_governance($1::uuid,$2) AS n",[A,MANIFEST])).rows[0].n).toBe(1);
      expect(await count("marketplace_governance_events")).toBe(0);expect(await count("marketplace_governance_events","tenant_id",B)).toBe(1);
      const policy=await one<{prosecdef:boolean;owner:string;public_execute:boolean;proconfig:string[]}>(`SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner,p.proconfig,
        has_function_privilege('public',p.oid,'EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.proname='erase_tenant_marketplace_governance'`,[schemaName]);
      expect(policy).toMatchObject({prosecdef:true,owner:"platform_erasure",public_execute:false});expect(policy.proconfig).toEqual([`search_path=${schemaName}, pg_temp`]);
    });

    it("no manifest is left able to authorise a later erasure of the same tenant", async () => {
      await service.deleteSubjectData(ten(A), MANIFEST);
      const state = await one<{ state: string }>("SELECT state FROM tenant_erasure_manifests WHERE manifest_id = $1", [MANIFEST]);
      expect(state.state).toBe("complete");
      await expect(pool.query("SELECT erase_tenant_action_annotations($1::uuid, $2)", [A, MANIFEST])).rejects.toThrow("no active erasure manifest");
    });
  });

  it("erases one workspace from the live schema, leaving the tenant and its other workspace (D2)", async () => {
    const wsA2 = "00000000-0000-7000-8000-00000000a102";
    await admin.query(`INSERT INTO workspaces (id, tenant_id, name, status) VALUES ($1, $2, 'A2', 'active')`, [wsA2, A]);
    await admin.query(`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4, 'editor')`, [randomUUID(), A, wsA2, u1]);
    await admin.query(`INSERT INTO workspace_invitations (id,tenant_id,workspace_id,email,role,status,invited_by,provider_org_ref)
      VALUES (gen_random_uuid(),$1,$2,'other-workspace@erasure.test','viewer','delivery_failed',$3,'org_erasure')`, [A, wsA2, u1]);
    const wsId = `ws_${wsA}`;

    const located = await service.locateWorkspaceData(ten(A), wsId);
    const rowsOf = (table: string) => located.find((location) => location.table === table)?.rowCount;
    expect(rowsOf("workspaces")).toBe(1);
    expect(rowsOf("workspace_members")).toBe(2);
    expect(rowsOf("workspace_invitations")).toBe(4);
    expect(rowsOf("oauth_connections")).toBe(1);
    expect(rowsOf("notification_reads")).toBe(1);
    // Tenant-wide and legal-hold tables are never part of a workspace.
    for (const table of ["billing_policy_state", "billing_credit_deliveries", "billing_subscription_plans", "tenant_members", "billing_events", "billing_profiles", "entitlements", "orders", "credential_refs"]) {
      expect(rowsOf(table)).toBeUndefined();
    }

    await expect(service.deleteWorkspaceData(ten(A), wsId, MANIFEST)).resolves.toMatchObject({ deletedObjects: 1 });
    await expect(service.verifyWorkspaceDeletion(ten(A), wsId, MANIFEST)).resolves.toMatchObject({ deleted: true, remaining: [] });
    expect(await count("workspaces", "id", wsA)).toBe(0);
    expect(await count("workspace_invitations", "workspace_id", wsA)).toBe(0);
    expect(await count("workspace_invitations", "workspace_id", wsA2)).toBe(1);
    expect(await count("workspace_invitations", "tenant_id", B)).toBe(4);
    expect(await count("workspaces", "id", wsA2)).toBe(1);
    expect(Number((await one<{ n: string }>("SELECT count(*)::text AS n FROM workspace_members WHERE workspace_id = $1", [wsA2])).n)).toBe(1);
    expect(await count("tenant_members")).toBe(2);
    expect(await count("billing_events")).toBe(1);
    for (const table of ["billing_policy_state", "billing_credit_deliveries", "billing_subscription_plans"]) expect(await count(table),table).toBe(1);
    expect(await count("tenants", "id")).toBe(1);
    expect([...secrets.values.keys()].sort()).toEqual([
      `/alter/credentials/${A}/00000000-0000-7000-8000-0000000c0001`,
      `/alter/credentials/${B}/00000000-0000-7000-8000-0000000c0002`,
      `/alter/env-vars/${A}/00000000-0000-7000-8000-0000000e0001`,
    ]);
    expect(await count("workspaces", "tenant_id", B)).toBe(1);

    // A second run finds nothing and still verifies.
    await expect(service.deleteWorkspaceData(ten(A), wsId, MANIFEST)).resolves.toMatchObject({ deletedRows: 0, deletedObjects: 0 });
  });

  it("lists every tenant, tombstones included, for the ledger replay", async () => {
    await service.deleteSubjectData(ten(A), MANIFEST);
    expect(await service.listSubjectIds()).toEqual([ten(A), ten(B)]);
  });
});

async function applyMainMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  const sql = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n--> statement-breakpoint\n");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
}
