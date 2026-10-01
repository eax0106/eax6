/**
 * D2 workspace erasure, derived from the live schema rather than hand-written
 * per table: a table holds a workspace's rows when it carries the workspace
 * column itself, or when a foreign key leads to a table that does. The
 * predicates below are built from the database's own catalog, so a new table
 * joins the workspace's erasure the day its migration adds the column or the
 * foreign key.
 *
 * Every predicate binds $1 = tenant id and $2 = workspace id (bare uuids, compared as text).
 */

/** Minimal client shape: a pg client, a pool, or a tenant transaction. */
export interface ScopeQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
}

export interface WorkspaceScopeRoot {
  /** A table whose own key column is the workspace id (platform's `workspaces.id`). */
  readonly table: string;
  readonly keyColumn: string;
}

export interface WorkspaceScopePlan {
  /** Table name to a WHERE predicate over that table (unaliased), in input order. */
  readonly scoped: ReadonlyMap<string, string>;
  /** Input tables with no path to a workspace: tenant-wide data, not erased with one. */
  readonly unscoped: readonly string[];
}

interface ForeignKey {
  readonly child: string;
  readonly parent: string;
  readonly childColumns: readonly string[];
  readonly parentColumns: readonly string[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Builds the workspace predicate of each table in `tables` (the current schema).
 * A table with `tenant_id` and `workspace_id` is scoped directly; otherwise
 * the first foreign key (by constraint name) to an already-scoped table in
 * `tables` scopes it through its parent. Tables are resolved to a fixed point,
 * so input order does not matter.
 */
export async function planWorkspaceScope(
  client: ScopeQueryable,
  tables: readonly string[],
  root?: WorkspaceScopeRoot,
): Promise<WorkspaceScopePlan> {
  for (const table of tables) requireIdentifier(table);
  const columns = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tables],
  );
  const columnsOf = new Map<string, Set<string>>();
  for (const row of columns.rows) {
    const set = columnsOf.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    columnsOf.set(row.table_name, set);
  }
  const keys = await client.query<{ child: string; parent: string; child_columns: string[]; parent_columns: string[] }>(
    `SELECT child.relname::text AS child, parent.relname::text AS parent,
            array_agg(ca.attname::text ORDER BY k.ord) AS child_columns,
            array_agg(pa.attname::text ORDER BY k.ord) AS parent_columns
       FROM pg_constraint c
       JOIN pg_class child ON child.oid = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace AND n.nspname = current_schema()
       CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(child_attnum, parent_attnum, ord)
       JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.child_attnum
       JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_attnum
      WHERE c.contype = 'f' AND child.relname = ANY($1::text[]) AND parent.relname = ANY($1::text[])
      GROUP BY c.oid, c.conname, child.relname, parent.relname
      ORDER BY c.conname`,
    [tables],
  );
  const foreignKeys: ForeignKey[] = keys.rows.map((row) => ({
    child: row.child,
    parent: row.parent,
    childColumns: [...row.child_columns],
    parentColumns: [...row.parent_columns],
  }));

  const predicates = new Map<string, string>();
  for (const table of tables) {
    const own = columnsOf.get(table) ?? new Set<string>();
    if (root !== undefined && table === root.table) {
      requireIdentifier(root.keyColumn);
      predicates.set(table, `tenant_id::text = $1::text AND ${root.keyColumn}::text = $2::text`);
    } else if (own.has("tenant_id") && own.has("workspace_id")) {
      predicates.set(table, "tenant_id::text = $1::text AND workspace_id::text = $2::text");
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables) {
      if (predicates.has(table)) continue;
      const key = foreignKeys.find((fk) => fk.child === table && fk.parent !== table && predicates.has(fk.parent));
      if (key === undefined) continue;
      const childColumns = key.childColumns.map(requireIdentifier).join(", ");
      const parentColumns = key.parentColumns.map(requireIdentifier).join(", ");
      predicates.set(
        table,
        `(${childColumns}) IN (SELECT ${parentColumns} FROM ${key.parent} WHERE ${predicates.get(key.parent)!})`,
      );
      changed = true;
    }
  }

  const scoped = new Map<string, string>();
  for (const table of tables) {
    const predicate = predicates.get(table);
    if (predicate !== undefined) scoped.set(table, predicate);
  }
  return { scoped, unscoped: tables.filter((table) => !predicates.has(table)) };
}

function requireIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe SQL identifier in workspace scope: ${value}`);
  return value;
}
