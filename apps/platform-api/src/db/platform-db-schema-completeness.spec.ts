import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required for the platform-api DB integration test target",
    );
  }
  return value;
})();

const migrationsPath = join(__dirname, "migrations");

function migrationStatements(): string[] {
  const sql = readdirSync(migrationsPath)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(migrationsPath, file), "utf8"))
    .join("\n--> statement-breakpoint\n");

  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function migrationDeclaredTableNames(): string[] {
  // Tables the migrations create, in order, less any a later migration drops
  // (0027 retires budgets, which moved to the engine).
  const created: string[] = [];
  const dropped = new Set<string>();
  for (const file of readdirSync(migrationsPath).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsPath, file), "utf8").replace(/--.*$/gm, "");
    for (const match of sql.matchAll(
      /(CREATE|DROP) TABLE(?: IF (?:NOT )?EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
    )) {
      const name = match[2] ?? match[3] ?? "";
      if (match[1]!.toUpperCase() === "CREATE") {
        created.push(name);
        dropped.delete(name);
      } else {
        dropped.add(name);
      }
    }
  }
  expect(new Set(created).size).toBe(created.length);
  return created.filter((name) => name && !dropped.has(name)).sort();
}

describe("platform_db schema completeness", () => {
  let adminClient: pg.Client;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `schema_${randomUUID().replaceAll("-", "_")}`;
    adminClient = new pg.Client({ connectionString: databaseUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE SCHEMA "${schemaName}"`);
    await adminClient.query(`SET search_path TO "${schemaName}"`);

    for (const statement of migrationStatements()) {
      await adminClient.query(statement);
    }
  });

  afterEach(async () => {
    if (adminClient) {
      await adminClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminClient.end();
    }
  });

  it("creates every table declared by platform migrations", async () => {
    const { rows } = await adminClient.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schemaName],
    );

    expect(rows.map((row) => row.table_name)).toEqual(migrationDeclaredTableNames());
  });
});
