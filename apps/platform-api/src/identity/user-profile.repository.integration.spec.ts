import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserProfileRepository } from "./user-profile.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";
const migrationsPath = join(__dirname, "../db/migrations");

function statements(files: string[]): string[] {
  return files
    .map((file) => readFileSync(join(migrationsPath, file), "utf8"))
    .join("\n--> statement-breakpoint\n")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// The profile name a user sets is stored on their own users row and read
// back by GET /api/v1/auth/me.
describe.skipIf(!databaseUrl)("UserProfileRepository display name, PostgreSQL", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `user_profile_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    for (const statement of statements(["0000_platform_db_identity_foundation.sql"])) {
      await admin.query(statement);
    }
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("stores the new name on that user only and reads it back", async () => {
    const user = randomUUID();
    const other = randomUUID();
    for (const [id, email] of [[user, "a@example.com"], [other, "b@example.com"]]) {
      await admin.query(
        "INSERT INTO users (id, identity_ref, email, display_name, status) VALUES ($1, $2, $3, 'Old', 'active')",
        [id, `auth0|${id}`, email],
      );
    }
    const repository = new UserProfileRepository(pool);

    await expect(repository.updateDisplayName(user, "New Name")).resolves.toMatchObject({ email: "a@example.com", display_name: "New Name" });
    await expect(repository.findById(user)).resolves.toMatchObject({ display_name: "New Name" });
    await expect(repository.findById(other)).resolves.toMatchObject({ display_name: "Old" });
    await expect(repository.updateDisplayName(randomUUID(), "Nobody")).resolves.toBeNull();
  });
});
