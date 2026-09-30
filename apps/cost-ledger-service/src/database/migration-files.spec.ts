import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COST_MIGRATIONS_PATH } from "./migrations-path";

const migrationFiles = readdirSync(COST_MIGRATIONS_PATH)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationSql = migrationFiles.map((file) => ({
  file,
  sql: readFileSync(resolve(COST_MIGRATIONS_PATH, file), "utf8"),
}));

describe("cost_db migration files", () => {
  it("keeps ordered migrations and matching rollbacks", () => {
    expect(migrationFiles).toEqual([
      "0000_create_cost_events.sql",
      "0001_create_billing_rollups.sql",
      "0002_billing_rollup_currency.sql",
      "0003_create_model_pricing.sql",
      "0004_create_model_outcomes.sql",
      "0005_fx_rate_and_usd_amount.sql",
      "0006_price_models_per_token_direction.sql",
      "0007_create_run_verdicts.sql",
      "0008_erasure_grants.sql",
    ]);
    expect(
      readdirSync(resolve(COST_MIGRATIONS_PATH, "rollback"))
        .filter((file) => file.endsWith(".sql"))
        .sort(),
    ).toEqual([
      "0000_drop_cost_events.sql",
      "0001_drop_billing_rollups.sql",
      "0002_drop_billing_rollup_currency.sql",
      "0003_drop_model_pricing.sql",
      "0004_drop_model_outcomes.sql",
      "0005_drop_fx_rate_and_usd_amount.sql",
      "0006_drop_model_price_dimension.sql",
      "0007_drop_run_verdicts.sql",
      "0008_drop_erasure_grants.sql",
    ]);
  });

  it.each(migrationSql.filter(({ sql }) => sql.includes("CREATE TABLE")))(
    "$file forces default-deny RLS",
    ({ file, sql }) => {
      expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
      expect(sql).toContain("FORCE ROW LEVEL SECURITY");
      
      if (file !== "0003_create_model_pricing.sql") {
        expect(sql).toContain(
          "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid",
        );
      }
      expect(sql).toContain("WITH CHECK");
    },
  );

  it("guards cost_events tenant_id as fully immutable", () => {
    const sql = migrationSql.find(
      ({ file }) => file === "0000_create_cost_events.sql",
    )?.sql;

    expect(sql).toContain("CREATE OR REPLACE FUNCTION reject_tenant_id_change");
    expect(sql).toContain(
      'CREATE TRIGGER "cost_events_reject_tenant_id_change"',
    );
    expect(sql).toContain("EXECUTE FUNCTION reject_tenant_id_change()");
  });

  it("guards billing_rollups tenant_id: only a non-null -> NULL transition is allowed", () => {
    const sql = migrationSql.find(
      ({ file }) => file === "0001_create_billing_rollups.sql",
    )?.sql;

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION reject_billing_rollup_tenant_reassignment",
    );
    expect(sql).toContain(
      "NEW.tenant_id IS NOT NULL AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id",
    );
    expect(sql).toContain(
      'CREATE TRIGGER "billing_rollups_reject_tenant_reassignment"',
    );
  });

  it("grants the BYPASSRLS provisioner role only what right-to-delete and retention need", () => {
    const sql = migrationSql.find(
      ({ file }) => file === "0001_create_billing_rollups.sql",
    )?.sql;

    expect(sql).toContain("CREATE ROLE cost_ledger_provisioner BYPASSRLS");
    expect(sql).toContain(
      'GRANT SELECT, INSERT, DELETE ON "cost_events" TO cost_ledger_provisioner',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_rollups" TO cost_ledger_provisioner',
    );
    expect(sql).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "cost_events"',
    );
    expect(sql).toContain(
      "GRANT cost_ledger_provisioner TO cost_ledger_service",
    );
  });

  it("grants the BYPASSRLS provisioner role real table privileges on model_pricing and model_outcomes", () => {
    // Both tables previously shipped with an RLS POLICY but no table-level
    // GRANT for cost_ledger_provisioner -- real CI caught "permission
    // denied" for model_pricing (ENGINE-FIX-16); asserting both here so the
    // same class of bug can't silently ship again.
    const allSql = migrationSql.map(({ sql }) => sql).join("\n");

    expect(allSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "model_pricing" TO cost_ledger_provisioner',
    );
    expect(allSql).toContain(
      'GRANT SELECT, INSERT ON "model_outcomes" TO cost_ledger_provisioner',
    );
  });

  it("keeps required check constraints and indexes", () => {
    const allSql = migrationSql.map(({ sql }) => sql).join("\n");

    expect(allSql).toContain(
      `CONSTRAINT "cost_events_mode_check" CHECK ("mode" IN ('workflow', 'project'))`,
    );
    expect(allSql).toContain(
      `CONSTRAINT "cost_events_source_check" CHECK ("source" IN ('model_gateway', 'tool_gateway', 'sandbox', 'storage', 'browser'))`,
    );
    expect(allSql).toContain(
      'CREATE INDEX "idx_cost_events_tenant_occurred" ON "cost_events" ("tenant_id", "occurred_at")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "billing_rollups_tenant_pseudonym_period_mode_currency_unique"',
    );
    expect(allSql).toContain(
      'CHECK ("currency" IN (\'USD\', \'INR\'))',
    );
    expect(allSql).toContain(
      'CONSTRAINT "billing_rollups_period_check" CHECK ("period_end" >= "period_start")',
    );
    expect(allSql).toContain(
      `CONSTRAINT "cost_events_fx_rate_used_check" CHECK ("fx_rate_used" IS NULL OR "fx_rate_used" > 0)`,
    );
    expect(allSql).toContain(
      `CONSTRAINT "cost_events_amount_usd_check" CHECK ("amount_usd" IS NULL OR "amount_usd" >= 0)`,
    );
  });

  it("contains no cross-database references", () => {
    const allSql = migrationSql.map(({ sql }) => sql).join("\n");

    expect(allSql).not.toMatch(
      /platform_db|marketplace_db|audit_db|orchestration_db|intelligence_db|policy_db|eval_db/i,
    );
  });

  it("local bootstrap creates isolated cost database ownership", () => {
    const script = readFileSync(
      resolve(process.cwd(), "infrastructure/local/engine-db-init.sh"),
      "utf8",
    );

    expect(script).toContain("CREATE ROLE cost_ledger_service LOGIN PASSWORD");
    expect(script).toContain(
      "CREATE DATABASE cost_db OWNER cost_ledger_service",
    );
    expect(script).toContain(
      "REVOKE CONNECT, TEMPORARY ON DATABASE cost_db FROM PUBLIC",
    );
    expect(script).toContain(
      "GRANT CONNECT, TEMPORARY ON DATABASE cost_db TO cost_ledger_service",
    );
  });
});
