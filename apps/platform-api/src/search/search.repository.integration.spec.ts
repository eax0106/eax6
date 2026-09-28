import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { applyMarketplaceMigrations } from "../db/marketplace-migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketplaceSearchRepository } from "./search.repository";

// Parallel spec files all grant on the one `public` schema row; concurrent
// ACL updates fail with "tuple concurrently updated", so they take turns.
const PUBLIC_SCHEMA_ACL_LOCK = 7_210_031;

const tenantA = "ten_search_a";
const tenantB = "ten_search_b";

describe("MarketplaceSearchRepository PostgreSQL integration", () => {
  let container: StartedPostgreSqlContainer;
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: MarketplaceSearchRepository;
  let schemaName: string;
  let roleName: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine").start();
  }, 30_000);
  beforeEach(async () => {
    schemaName = `search_${randomUUID().replaceAll("-", "_")}`;
    roleName = `search_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: container.getConnectionUri() }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    // public stays on the path alongside the private schema: this file's
    // own beforeEach reruns marketplace-migrations' pg_trgm extension
    // create into a fresh schema every test, but CREATE EXTENSION is
    // once-per-database -- only the first test in this file actually
    // creates it (into whichever schema is first on its own search_path
    // at that moment), every later test's IF NOT EXISTS no-ops, and
    // gin_trgm_ops then needs to resolve from wherever the first test put
    // it. Pinning the migration to SCHEMA public (0003_search_indexes.sql)
    // and keeping public on every test's search_path here makes that
    // deterministic instead of only ever working for the first test.
    await admin.query(`SET search_path TO "${schemaName}", public`); await applyMarketplaceMigrations(admin);
    const password = randomUUID(); await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`); await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`); await admin.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(${PUBLIC_SCHEMA_ACL_LOCK}); GRANT USAGE ON SCHEMA public TO "${roleName}"; END $$`); await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(container.getConnectionUri()); url.username = roleName; url.password = password; url.searchParams.set("options", `-c search_path=${schemaName},public`);
    pool = new pg.Pool({ connectionString: url.toString() }); repository = new MarketplaceSearchRepository(pool);
  });
  // REVOKE the public-schema USAGE grant before DROP ROLE: public itself is
  // never dropped, so that grant outlives the private schema's own DROP ...
  // CASCADE and otherwise blocks the role drop ("role ... cannot be dropped
  // because some objects depend on it").
  afterEach(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); await admin.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(${PUBLIC_SCHEMA_ACL_LOCK}); REVOKE USAGE ON SCHEMA public FROM "${roleName}"; END $$`); await admin.query(`DROP ROLE IF EXISTS "${roleName}"`); await admin.end(); } });
  afterAll(async () => { await container?.stop(); });

  it("ranks FTS exact matches above partial matches and returns a one-character trigram typo", async () => {
    await listing("lst_exact", tenantA, "deploy", "Exact deployment");
    await listing("lst_partial", tenantA, "deploy pipeline", "Partial deployment");
    await listing("lst_fuzzy", tenantA, "depliy", "Typo tolerant result");
    const ranked = await repository.search(tenantB, { q: "deploy", kind: "listing", limit: 10 });
    expect(ranked.map((value) => value.id)).toEqual([
      "lst_exact",
      "lst_partial",
      "lst_fuzzy",
    ]);
    const fuzzy = await repository.search(tenantB, { q: "deply", kind: "listing", limit: 10 });
    expect(fuzzy.map((value) => value.id)).toContain("lst_fuzzy");
  });

  it("returns globally published owned entries while excluding drafts and blocked tools across tenants", async () => {
    await listing("lst_public", tenantA, "shared catalog", "public");
    await listing("lst_draft", tenantA, "secret catalog", "private", "draft");
    await tool("tlm_public", tenantA, "shared tool", "community_reviewed", "published");
    await tool("tlm_blocked", tenantA, "blocked tool", "blocked", "published");
    const publicResults = await repository.search(tenantB, { q: "shared", limit: 10 });
    expect(publicResults.map((value) => value.id)).toEqual(expect.arrayContaining(["lst_public", "tlm_public"]));
    const privateResults = await repository.search(tenantB, { q: "secret", limit: 10 });
    expect(privateResults.map((value) => value.id)).not.toContain("lst_draft");
    const blockedResults = await repository.search(tenantB, { q: "blocked", limit: 10 });
    expect(blockedResults.map((value) => value.id)).not.toContain("tlm_blocked");
  });

  async function listing(id: string, tenantId: string, name: string, description: string, status = "published") { await admin.query("INSERT INTO listings (id, tenant_id, type, name, description, license_type, status) VALUES ($1,$2,'agent',$3,$4,'tenant_wide',$5)", [id, tenantId, name, description, status]); }
  async function tool(id: string, tenantId: string, name: string, trustLevel: string, status: string) { await admin.query("INSERT INTO tool_manifests (id, tenant_id, name, ecosystem, trust_level, status) VALUES ($1,$2,$3,'npm',$4,$5)", [id, tenantId, name, trustLevel, status]); }
});

