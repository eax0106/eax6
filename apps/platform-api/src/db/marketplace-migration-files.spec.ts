import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETPLACE_MIGRATIONS_PATH } from "./marketplace-migrator";

// The per-directory completeness check cost-ledger-service,
// orchestration-service and audit-service each already have
// (apps/audit-service/src/database/migration-files.spec.ts is the model).
// platform-api had none, for either of its two migration sets, and
// scripts/check-migration-rollback-pairing.sh only ever scanned
// apps/*/drizzle -- so 0003_search_indexes.sql shipped with no rollback file
// and nothing anywhere noticed. See issue #171.

const migrationFiles = readdirSync(MARKETPLACE_MIGRATIONS_PATH)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const rollbackFiles = readdirSync(resolve(MARKETPLACE_MIGRATIONS_PATH, "rollback"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

describe("marketplace migration files", () => {
  it("keeps ordered migrations and matching rollbacks", () => {
    expect(migrationFiles).toEqual([
      "0000_marketplace_core.sql",
      "0001_publisher_payout.sql",
      "0002_tool_registry.sql",
      "0003_search_indexes.sql",
      "0004_scan_unavailable.sql",
      "0005_listing_pricing.sql",
      "0006_payout_ledger_erasure_guard.sql",
    ]);
    expect(rollbackFiles).toEqual([
      "0000_drop_marketplace_core.sql",
      "0001_drop_publisher_payout.sql",
      "0002_drop_tool_registry.sql",
      "0003_drop_search_indexes.sql",
      "0004_drop_scan_unavailable.sql",
      "0005_drop_listing_pricing.sql",
      "0006_drop_payout_ledger_erasure_guard.sql",
    ]);
  });

  it("pairs every migration index with a rollback of the same index", () => {
    const indexOf = (file: string): string => file.slice(0, 4);
    expect(rollbackFiles.map(indexOf)).toEqual(migrationFiles.map(indexOf));
  });

  it("leaves pg_trgm alone on the way back down", () => {
    // 0003 pins the extension to SCHEMA public because the four marketplace
    // specs migrate their own schemas concurrently and all resolve
    // gin_trgm_ops from there. A rollback that dropped it would break
    // whichever spec was mid-run.
    const sql = readFileSync(
      resolve(MARKETPLACE_MIGRATIONS_PATH, "rollback", "0003_drop_search_indexes.sql"),
      "utf8",
    );
    expect(sql).not.toMatch(/DROP\s+EXTENSION/i);
  });
});
