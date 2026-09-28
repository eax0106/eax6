import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformDb } from "../signup/platform-db";
import { I18nService } from "./i18n.service";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000011";
const workspaceId = "00000000-0000-7000-8000-000000000021";

describe.skipIf(!databaseUrl)("i18n PostgreSQL integration", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let schemaName: string;
  let service: I18nService;

  beforeEach(async () => {
    schemaName = `i18n_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    for (const statement of migrationStatements()) {
      await admin.query(statement);
    }
    await admin.query(
      `INSERT INTO tenants (id, name, status)
       VALUES ($1, 'I18n Tenant', 'active')`,
      [tenantId],
    );
    await admin.query(
      `INSERT INTO users (id, identity_ref, email, status)
       VALUES ($1, 'auth0|i18n', 'i18n@example.com', 'active')`,
      [userId],
    );
    await admin.query(
      `INSERT INTO workspaces (id, tenant_id, name, status)
       VALUES ($1, $2, 'I18n Workspace', 'active')`,
      [workspaceId, tenantId],
    );
    await admin.query(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'admin')`,
      [randomUUID(), tenantId, userId],
    );
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    service = new I18nService(new PlatformDb(pool));
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("serves the real minimal EN and HI seeded bundles and honors fallback", async () => {
    await expect(service.getBundle("en", "ui", tenantId)).resolves.toMatchObject({
      messages: { "language.english": "English" },
    });
    await expect(service.getBundle("hi", "ui", tenantId)).resolves.toMatchObject({
      messages: { "language.hindi": "हिन्दी" },
    });

    await admin.query("UPDATE users SET preferred_language = NULL WHERE id = $1", [userId]);
    await admin.query("UPDATE workspaces SET default_language = 'hi' WHERE id = $1", [workspaceId]);
    await expect(service.resolveLocale(userId, workspaceId, tenantId)).resolves.toBe("hi");
  });

  it("reads back the language a user saved, so another device starts in it", async () => {
    const actor = { tenant_id: tenantId, user_id: userId } as Parameters<I18nService["getUserLanguage"]>[0];

    await expect(service.getUserLanguage(actor)).resolves.toEqual({ language: "en" });
    await service.updateUserLanguage(actor, "hi");
    await expect(service.getUserLanguage(actor)).resolves.toEqual({ language: "hi" });
  });
});

function migrationStatements(): string[] {
  const directory = join(__dirname, "../db/migrations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .flatMap((file) =>
      readFileSync(join(directory, file), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean),
    );
}
