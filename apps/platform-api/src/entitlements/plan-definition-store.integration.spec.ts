import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresPlanDefinitionStore } from "./plan-definition-store";
import type { EntitlementLimits } from "./types";

const databaseUrl = process.env.DATABASE_URL ?? "";

const LIMITS: EntitlementLimits = {
  maxWorkflows: 200,
  maxProjects: 50,
  maxRunsPerDay: 10_000,
  maxConcurrentRuns: 25,
  maxSandboxMinutesPerMonth: 5_000,
  maxAdsStorageMb: 50_000,
  maxIntegrations: 100,
};

describe.skipIf(!databaseUrl)("plan_definitions PostgreSQL behaviour", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let store: PostgresPlanDefinitionStore;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `plan_definitions_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    await admin.query(
      `INSERT INTO staff_users (id, identity_ref, email, roles)
       VALUES ('stf_test', 'auth0|plan-definitions-test', 'ops@example.com', ARRAY['staff_admin'])`,
    );
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    store = new PostgresPlanDefinitionStore(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("inserts then updates through the same upsert, reporting created correctly", async () => {
    const created = await store.upsert("pro", LIMITS, "stf_test");
    expect(created.created).toBe(true);
    expect(created.record.limits).toEqual(LIMITS);

    const raised = { ...LIMITS, maxWorkflows: 500 };
    const updated = await store.upsert("pro", raised, "stf_test");
    expect(updated.created).toBe(false);
    expect(updated.record.limits).toEqual(raised);
    expect((await store.list()).length).toBe(1);
  });

  it("reads back a definition with all seven limit keys as numbers", async () => {
    await store.upsert("pro", LIMITS, "stf_test");
    const found = await store.find("pro");
    expect(found?.limits).toEqual(LIMITS);
    expect(Object.values(found!.limits).every((v) => typeof v === "number")).toBe(true);
  });

  it("rejects limits missing a key, carrying an unknown key, or holding a non-integer", async () => {
    const partial: Partial<EntitlementLimits> = { ...LIMITS };
    delete partial.maxIntegrations;
    await expect(
      admin.query(
        `INSERT INTO plan_definitions (plan, limits, updated_by)
         VALUES ('bad', $1::jsonb, 'stf_test')`,
        [JSON.stringify(partial)],
      ),
    ).rejects.toThrow();

    await expect(
      admin.query(
        `INSERT INTO plan_definitions (plan, limits, updated_by)
         VALUES ('bad', $1::jsonb, 'stf_test')`,
        [JSON.stringify({ ...LIMITS, maxUnicorns: 1 })],
      ),
    ).rejects.toThrow();

    await expect(
      admin.query(
        `INSERT INTO plan_definitions (plan, limits, updated_by)
         VALUES ('bad', $1::jsonb, 'stf_test')`,
        [JSON.stringify({ ...LIMITS, maxProjects: -1 })],
      ),
    ).rejects.toThrow();
  });

  it("persists configured commercial values, preserves them on a limits-only edit and can unset them", async () => {
    const commercial = { currency: "INR" as const, basePriceMinor: 10003, razorpayPlanId: "plan_fixture123",
      includedCredits: 100, extraCreditPriceMinor: 50, creditsPerVerifiedRun: 2 };
    await store.upsert("pro", LIMITS, "stf_test", commercial, "owner launch configuration");
    expect((await store.find("pro"))?.commercial).toEqual(commercial);
    expect((await store.history("pro", 1))[0]?.commercial).toEqual(commercial);
    await store.upsert("pro", { ...LIMITS, maxRunsPerDay: 5 }, "stf_test", undefined, "lower daily cap");
    expect((await store.find("pro"))?.commercial).toEqual(commercial);
    await expect(store.upsert("other", LIMITS, "stf_test", commercial)).rejects.toThrow();
    await store.upsert("pro", LIMITS, "stf_test", null, "disable checkout");
    expect((await store.find("pro"))?.commercial).toBeNull();
  });

  it("rolls a configuration edit back if its append-only audit cannot persist", async () => {
    await store.upsert("pro", LIMITS, "stf_test", null, "create");
    await admin.query(`CREATE FUNCTION reject_plan_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$;
      CREATE TRIGGER reject_plan_audit BEFORE INSERT ON plan_definition_audit
        FOR EACH ROW EXECUTE FUNCTION reject_plan_audit();`);
    await expect(store.upsert("pro", { ...LIMITS, maxRunsPerDay: 1 }, "stf_test", null, "update"))
      .rejects.toThrow("audit unavailable");
    expect((await store.find("pro"))?.limits).toEqual(LIMITS);
  });

  it("rejects malformed commercial values even through direct SQL", async () => {
    for (const commercial of [{}, { currency: "USD" }, {
      currency: "INR", basePriceMinor: -1, razorpayPlanId: null, includedCredits: null,
      extraCreditPriceMinor: null, creditsPerVerifiedRun: null,
    }]) {
      await expect(admin.query(`INSERT INTO plan_definitions (plan, limits, commercial, updated_by)
        VALUES ('bad', $1::jsonb, $2::jsonb, 'stf_test')`, [JSON.stringify(LIMITS), JSON.stringify(commercial)]))
        .rejects.toThrow();
    }
  });

  it("requires updated_by to reference a real staff user", async () => {
    await expect(
      admin.query(
        `INSERT INTO plan_definitions (plan, limits, updated_by)
         VALUES ('bad', $1::jsonb, 'stf_missing')`,
        [JSON.stringify(LIMITS)],
      ),
    ).rejects.toThrow();
  });

  it("removes a definition and reports whether a row was deleted", async () => {
    await store.upsert("pro", LIMITS, "stf_test");
    expect(await store.remove("pro")).toBe(true);
    expect(await store.remove("pro")).toBe(false);
    expect(await store.find("pro")).toBeUndefined();
  });

  it("keeps history newest-first and append-only, surviving the definition's deletion", async () => {
    await store.upsert("pro", LIMITS, "stf_test");
    await store.recordAudit("pro", "created", LIMITS, "launch pro", "stf_test");
    await store.recordAudit("pro", "deleted", LIMITS, "retire pro", "stf_test");
    await store.remove("pro");

    const history = await store.history("pro", 50);
    expect(history.map((entry) => entry.action)).toEqual(["deleted", "created"]);

    await expect(
      admin.query(`UPDATE plan_definition_audit SET reason = 'tampered'`),
    ).rejects.toThrow("append-only");
    await expect(
      admin.query(`DELETE FROM plan_definition_audit`),
    ).rejects.toThrow("append-only");
  });

  it("honours the history limit", async () => {
    for (const reason of ["one", "two", "three"]) {
      await store.recordAudit("pro", "updated", LIMITS, reason, "stf_test");
    }
    expect((await store.history("pro", 2)).length).toBe(2);
  });
});

async function applyMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  const sql = [
    "0000_platform_db_identity_foundation.sql",
    "0006_billing_profiles.sql",
    "0007_billing_webhooks.sql",
    "0010_staff_plane.sql",
    "0014_plan_definitions.sql",
    "0034_subscription_commercial.sql",
  ]
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n--> statement-breakpoint\n");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
}
