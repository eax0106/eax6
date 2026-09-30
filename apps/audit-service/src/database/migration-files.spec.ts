import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_MIGRATIONS_PATH } from "./migrations-path";

// ENGINE-FIX-P3-29 (Wave 4 item 5): audit-service was the one drizzle
// service in the monorepo with real rollback files on disk (drizzle/
// rollback/) but no test asserting they exist or are complete -- unlike
// cost-ledger-service's and orchestration-service's own migration-
// files.spec.ts. A migration could ship without a matching rollback file
// and nothing would catch it. scripts/check-migration-rollback-pairing.sh
// is the repo-wide backstop this gap motivated; this file is the same
// per-service completeness check its two siblings already have.

const migrationFiles = readdirSync(AUDIT_MIGRATIONS_PATH)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationSql = migrationFiles.map((file) => ({
  file,
  sql: readFileSync(resolve(AUDIT_MIGRATIONS_PATH, file), "utf8"),
}));

describe("audit_db migration files", () => {
  it("keeps ordered migrations and matching rollbacks", () => {
    expect(migrationFiles).toEqual([
      "0000_create_audit_events.sql",
      "0001_create_deletion_records.sql",
      "0002_audit_chain_checkpoint.sql",
      "0003_signed_checkpoint_compaction.sql",
    ]);
    expect(
      readdirSync(resolve(AUDIT_MIGRATIONS_PATH, "rollback"))
        .filter((file) => file.endsWith(".sql"))
        .sort(),
    ).toEqual([
      "0000_drop_audit_events.sql",
      "0001_drop_deletion_records.sql",
      "0002_drop_audit_chain_checkpoint.sql",
      "0003_drop_signed_checkpoint_compaction.sql",
    ]);
  });

  it("forces default-deny RLS on audit_events, the one real tenant-scoped table", () => {
    const sql = migrationSql.find(({ file }) => file === "0000_create_audit_events.sql")?.sql;

    expect(sql).toContain('ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY');
  });

  it("keeps required audit_events check constraints", () => {
    const sql = migrationSql.find(({ file }) => file === "0000_create_audit_events.sql")?.sql;

    expect(sql).toContain(
      `CONSTRAINT "audit_events_actor_type_check" CHECK ("actor_type" IN ('user', 'service', 'admin', 'support', 'system'))`,
    );
    expect(sql).toContain(
      `CONSTRAINT "audit_events_result_check" CHECK ("result" IN ('success', 'denied', 'error'))`,
    );
    expect(sql).toContain(
      `CONSTRAINT "audit_events_hash_length_check" CHECK (octet_length("prev_hash") = 32 AND octet_length("entry_hash") = 32)`,
    );
  });

  it("guards deletion_certificates and deletion_ledger as fully append-only", () => {
    const sql = migrationSql.find(({ file }) => file === "0001_create_deletion_records.sql")?.sql;

    expect(sql).toContain("CREATE OR REPLACE FUNCTION reject_deletion_record_mutation");
    expect(sql).toContain('CREATE TRIGGER "deletion_certificates_append_only"');
    expect(sql).toContain('CREATE TRIGGER "deletion_ledger_append_only"');
    expect(sql).toContain("EXECUTE FUNCTION reject_deletion_record_mutation()");
  });

  it("keeps the audit-chain checkpoint's real invariants", () => {
    const sql = migrationSql.find(({ file }) => file === "0002_audit_chain_checkpoint.sql")?.sql;
    const signedCheckpointSql = migrationSql.find(({ file }) => file === "0003_signed_checkpoint_compaction.sql")?.sql;

    expect(sql).toContain(
      `CONSTRAINT "audit_chain_checkpoints_hash_length_check" CHECK (octet_length("last_entry_hash") = 32)`,
    );
    expect(sql).toContain(
      `CONSTRAINT "audit_chain_checkpoints_checked_events_check" CHECK ("checked_events" >= 0)`,
    );
    expect(signedCheckpointSql).toContain(
      `CONSTRAINT "audit_chain_checkpoints_signature_length_check" CHECK (octet_length("signature") = 32)`,
    );
    expect(signedCheckpointSql).toContain(
      `CONSTRAINT "audit_chain_checkpoints_signature_key_id_check" CHECK (length(btrim("signature_key_id")) > 0)`,
    );
  });

  it("keeps audit compaction behind the sealed-checkpoint function", () => {
    const sql = migrationSql.find(({ file }) => file === "0003_signed_checkpoint_compaction.sql")?.sql;

    expect(sql).toContain("CREATE OR REPLACE FUNCTION compact_audit_events_before_checkpoint");
    expect(sql).toContain("current_setting('app.audit_retention_compaction', true) = 'on'");
    expect(sql).toContain("WHERE entry_hash <> sealed_entry_hash");
  });
});
