import { describe, expect, it } from "vitest";
import type { TenantDataDeclaration, TenantDataExemption } from "./declaration";
import { MAX_ERASURE_GAPS, tenantDataDeclarations, tenantDataExemptions } from "./declaration";
import { certifyDatabase, compareProviderTables, erasureGaps, listLiveTables } from "./verify";

const declared = (table: string, provider?: "orchestration-service"): TenantDataDeclaration => ({
  database: "orchestration_db",
  schema: "public",
  table,
  owner: "orchestration-service",
  erasure: provider ? { kind: "provider", provider } : { kind: "gap", note: "not reached" },
});
const exempt = (table: string): TenantDataExemption => ({
  database: "orchestration_db",
  schema: "public",
  table,
  owner: "orchestration-service",
  reason: "bookkeeping",
});

describe("deletion registry verification (C3)", () => {
  it("passes only when every live table is declared or exempt exactly once", () => {
    expect(certifyDatabase("orchestration_db", ["public.runs", "public.meta"], [declared("runs")], [exempt("meta")])).toEqual([]);
  });

  it("reports a live table nobody registered, an entry for a table that no longer exists, and a duplicate", () => {
    expect(
      certifyDatabase("orchestration_db", ["public.runs", "public.new_table"], [declared("runs"), declared("gone")], [exempt("runs")]),
    ).toEqual([
      { database: "orchestration_db", table: "public.runs", problem: "duplicate" },
      { database: "orchestration_db", table: "public.new_table", problem: "unregistered" },
      { database: "orchestration_db", table: "public.gone", problem: "stale" },
    ]);
  });

  it("ignores another database's entries", () => {
    expect(certifyDatabase("audit_db", [], [declared("runs")], [])).toEqual([]);
  });

  it("finds tables the registry promises a provider erases but it does not, and the reverse", () => {
    expect(
      compareProviderTables("orchestration-service", [declared("runs", "orchestration-service"), declared("events", "orchestration-service"), declared("gap_table")], ["runs", "secrets"]),
    ).toEqual({ declaredOnly: ["events"], providerOnly: ["secrets"] });
  });

  it("lists live tables from pg_catalog, schema-qualified and sorted", async () => {
    const tables = await listLiveTables({
      query: async () => ({ rows: [{ schema_name: "public", table_name: "runs" }, { schema_name: "drizzle", table_name: "m" }] }),
    });
    expect(tables).toEqual(["drizzle.m", "public.runs"]);
  });

  it("keeps the registry itself well-formed: unique entries, reasons given, gap count at its ceiling", () => {
    const keys = [...tenantDataDeclarations, ...tenantDataExemptions].map((e) => `${e.database}.${e.schema}.${e.table}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(tenantDataExemptions.every((e) => e.reason.trim().length > 0)).toBe(true);
    expect(erasureGaps(tenantDataDeclarations).length).toBe(MAX_ERASURE_GAPS);
  });
});
