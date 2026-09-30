import type { ClientBase, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { applyMarketplaceMigrations } from "./marketplace-migrator";

// The runner's logic, without a database: which files it decides to apply,
// what it records, the order it unwinds in, and that it refuses rather than
// half-applies. The real SQL is exercised against real Postgres in
// marketplace-migrator.integration.spec.ts, which runs in test-db-integration
// -- several DB-backed specs in parallel workers time each other out, so it
// cannot live in the default suite.

const MIGRATION_TAGS = [
  "0000_marketplace_core",
  "0001_publisher_payout",
  "0002_tool_registry",
  "0003_search_indexes",
  "0004_scan_unavailable",
  "0005_listing_pricing",
  "0006_payout_ledger_erasure_guard",
];

/**
 * Records every statement and answers ledger SELECTs from `applied`, which it
 * keeps up to date as the runner inserts and deletes rows.
 */
function fakeClient(applied: string[] = []) {
  const statements: string[] = [];
  const ledger = [...applied];

  const client = {
    async query(sql: string, values?: unknown[]): Promise<QueryResult> {
      statements.push(sql);
      if (sql.includes(`SELECT "tag" FROM`)) {
        return {
          rows: [...ledger].sort().map((tag) => ({ tag })),
        } as unknown as QueryResult;
      }
      if (sql.startsWith(`INSERT INTO`)) {
        ledger.push(String(values?.[0]));
      }
      if (sql.startsWith(`DELETE FROM`)) {
        const index = ledger.indexOf(String(values?.[0]));
        if (index >= 0) ledger.splice(index, 1);
      }
      return { rows: [] } as unknown as QueryResult;
    },
  } as unknown as ClientBase;

  return { client, statements, ledger };
}

describe("applyMarketplaceMigrations", () => {
  it("applies every migration in order on an empty database", async () => {
    const { client, ledger } = fakeClient();

    expect(await applyMarketplaceMigrations(client)).toEqual(MIGRATION_TAGS);
    expect(ledger).toEqual(MIGRATION_TAGS);
  });

  it("applies only what is missing", async () => {
    const { client } = fakeClient(MIGRATION_TAGS.slice(0, 3));

    expect(await applyMarketplaceMigrations(client)).toEqual([
      "0003_search_indexes",
      "0004_scan_unavailable",
      "0005_listing_pricing",
      "0006_payout_ledger_erasure_guard",
    ]);
  });

  it("does nothing when everything is applied", async () => {
    const { client, statements } = fakeClient(MIGRATION_TAGS);

    expect(await applyMarketplaceMigrations(client)).toEqual([]);
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(0);
  });

  it("takes and releases the advisory lock around the whole run", async () => {
    // Without it, CREATE EXTENSION IF NOT EXISTS races between the four
    // marketplace specs' parallel workers.
    const { client, statements } = fakeClient();

    await applyMarketplaceMigrations(client);

    expect(statements[0]).toContain("pg_advisory_lock");
    expect(statements[statements.length - 1]).toContain("pg_advisory_unlock");
  });

  it("releases the advisory lock even when a migration fails", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<QueryResult> {
        statements.push(sql);
        if (sql.includes(`SELECT "tag" FROM`)) {
          return { rows: [] } as unknown as QueryResult;
        }
        if (sql.includes("CREATE TABLE") && sql.includes("listings")) {
          throw new Error("relation already exists");
        }
        return { rows: [] } as unknown as QueryResult;
      },
    } as unknown as ClientBase;

    await expect(applyMarketplaceMigrations(client)).rejects.toThrow(
      "relation already exists",
    );
    expect(statements).toContain("ROLLBACK");
    expect(statements[statements.length - 1]).toContain("pg_advisory_unlock");
  });

  it("unwinds newest first", async () => {
    const { client, ledger } = fakeClient(MIGRATION_TAGS);

    expect(
      await applyMarketplaceMigrations(client, { direction: "down" }),
    ).toEqual([...MIGRATION_TAGS].reverse());
    expect(ledger).toEqual([]);
  });

  it("unwinds only the requested number of steps", async () => {
    const { client, ledger } = fakeClient(MIGRATION_TAGS);

    expect(
      await applyMarketplaceMigrations(client, { direction: "down", steps: 2 }),
    ).toEqual(["0006_payout_ledger_erasure_guard", "0005_listing_pricing"]);
    expect(ledger).toEqual(MIGRATION_TAGS.slice(0, 5));
  });

  it("treats a zero or negative step count as nothing to do", async () => {
    const { client } = fakeClient(MIGRATION_TAGS);

    expect(
      await applyMarketplaceMigrations(client, { direction: "down", steps: 0 }),
    ).toEqual([]);
  });

  it("refuses to unwind a migration whose rollback file is missing", async () => {
    // The gap that shipped: 0003 had no rollback file and nothing noticed.
    // A ledger row with no way back out must fail loudly, not leave the
    // schema and the ledger disagreeing.
    const { client } = fakeClient(["0009_invented_migration"]);

    await expect(
      applyMarketplaceMigrations(client, { direction: "down" }),
    ).rejects.toThrow(/no rollback file for applied migration 0009_invented_migration/);
  });
});
