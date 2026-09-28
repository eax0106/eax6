import type {
  DatabaseName,
  ErasureProvider,
  TenantDataDeclaration,
  TenantDataExemption,
} from "./declaration";

/** Minimal client shape: satisfied by pg.Client, a pool, or a test double. */
export interface Queryable {
  query(sql: string): Promise<{ rows: { schema_name: string; table_name: string }[] }>;
}

/**
 * Every base table, partitioned table and materialized view in a live
 * database, schema-qualified. pg_catalog, not information_schema: a
 * materialized view stores rows, and information_schema.tables does not list
 * one at all.
 */
export async function listLiveTables(client: Queryable): Promise<string[]> {
  const result = await client.query(
    `SELECT n.nspname AS schema_name, c.relname AS table_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'`,
  );
  return result.rows.map((row) => `${row.schema_name}.${row.table_name}`).sort();
}

export interface CoverageProblem {
  readonly database: DatabaseName;
  readonly table: string;
  readonly problem: "unregistered" | "stale" | "duplicate";
}

/**
 * Fail-closed coverage of one database: every live table is declared or
 * exempt exactly once, and every entry names a table that exists.
 */
export function certifyDatabase(
  database: DatabaseName,
  liveTables: readonly string[],
  declarations: readonly TenantDataDeclaration[],
  exemptions: readonly TenantDataExemption[],
): CoverageProblem[] {
  const entries = [...declarations, ...exemptions]
    .filter((entry) => entry.database === database)
    .map((entry) => `${entry.schema}.${entry.table}`);
  const seen = new Set<string>();
  const problems: CoverageProblem[] = [];
  for (const table of entries) {
    if (seen.has(table)) problems.push({ database, table, problem: "duplicate" });
    seen.add(table);
  }
  const live = new Set(liveTables);
  for (const table of liveTables) {
    if (!seen.has(table)) problems.push({ database, table, problem: "unregistered" });
  }
  for (const table of seen) {
    if (!live.has(table)) problems.push({ database, table, problem: "stale" });
  }
  return problems;
}

/**
 * The tables the registry says a provider erases, against the tables that
 * provider's own code erases. Either side missing a table is a lie: the
 * registry promising erasure the provider never performs, or the provider
 * erasing a table the registry does not know about.
 */
export function compareProviderTables(
  provider: ErasureProvider,
  declarations: readonly TenantDataDeclaration[],
  providerTables: readonly string[],
): { readonly declaredOnly: string[]; readonly providerOnly: string[] } {
  const declared = new Set(
    declarations
      .filter((entry) => entry.erasure.kind === "provider" && entry.erasure.provider === provider)
      .map((entry) => entry.table),
  );
  const actual = new Set(providerTables);
  return {
    declaredOnly: [...declared].filter((table) => !actual.has(table)).sort(),
    providerOnly: [...actual].filter((table) => !declared.has(table)).sort(),
  };
}

export function erasureGaps(declarations: readonly TenantDataDeclaration[]): TenantDataDeclaration[] {
  return declarations.filter((entry) => entry.erasure.kind === "gap");
}
