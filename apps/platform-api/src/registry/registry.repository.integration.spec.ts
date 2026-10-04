import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyMarketplaceMigrations } from "../db/marketplace-migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryRepository } from "./registry.repository";
import { ToolVersionReviewRepository } from "../marketplace-governance/tool-version-review.repository";

// Parallel spec files all grant on the one `public` schema row; concurrent
// ACL updates fail with "tuple concurrently updated", so they take turns.
const PUBLIC_SCHEMA_ACL_LOCK = 7_210_031;

const databaseUrl = process.env.MARKETPLACE_DATABASE_URL;
const tenantA = "ten_registry_a";
const tenantB = "ten_registry_b";
describe.skipIf(!databaseUrl)("RegistryRepository integration", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let operationsPool: pg.Pool;
  let repository: RegistryRepository;
  let schemaName: string;
  let roleName: string;
  beforeEach(async () => {
    schemaName = `registry_${randomUUID().replaceAll("-", "_")}`;
    roleName = `registry_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    // public stays on the path alongside the private schema: the shared
    // marketplace-migrations' pg_trgm extension is pinned to SCHEMA public
    // (see 0003_search_indexes.sql), so gin_trgm_ops needs to resolve from
    // there regardless of which spec's migration run actually created it.
    await admin.query(`SET search_path TO "${schemaName}", public`);
    // Advisory lock shared with marketplace/publisher/search specs -- CREATE
    // EXTENSION IF NOT EXISTS races on pg_extension under concurrent workers.
    // The advisory lock that used to sit here now lives inside
    // applyMarketplaceMigrations, so every caller gets it -- this spec's
    // search-side sibling never took it and was racing.
    await applyMarketplaceMigrations(admin);
    const password = randomUUID(); await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`); await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`); await admin.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(${PUBLIC_SCHEMA_ACL_LOCK}); GRANT USAGE ON SCHEMA public TO "${roleName}"; END $$`); await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`);
    const url = new URL(databaseUrl!); url.username = roleName; url.password = password; url.searchParams.set("options", `-c search_path=${schemaName},public`); pool = new pg.Pool({ connectionString: url.toString() }); const operationsUrl=new URL(databaseUrl!); operationsUrl.searchParams.set("options",`-c search_path=${schemaName},public`); operationsPool=new pg.Pool({connectionString:operationsUrl.toString()}); repository = new RegistryRepository(pool);
  });
  // REVOKE the public-schema USAGE grant before DROP ROLE: public itself is
  // never dropped, so that grant outlives the private schema's own DROP ...
  // CASCADE and otherwise blocks the role drop ("role ... cannot be dropped
  // because some objects depend on it").
  afterEach(async () => { await operationsPool?.end(); await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); await admin.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(${PUBLIC_SCHEMA_ACL_LOCK}); REVOKE USAGE ON SCHEMA public FROM "${roleName}"; END $$`); await admin.query(`DROP ROLE IF EXISTS "${roleName}"`); await admin.end(); } });
  async function publishReviewed(manifestId: string, versionId: string) {
    const scanId=`scn_${randomUUID()}`;
    await repository.beginScan(tenantA,manifestId,versionId);
    const waiting=await repository.completeScan(tenantA,manifestId,versionId,scanId,{verdict:"clean",findings:[],scannerVersion:"fixture",durationMs:1,scannedAt:new Date().toISOString()});
    expect(waiting.status).toBe("review_pending");
    await new ToolVersionReviewRepository(operationsPool).review(manifestId,versionId,"staff_fixture",{scanReportId:scanId,decision:"approved",reason:"Reviewed fixture package"},async()=>undefined);
  }
  it("hides tenant draft manifests and reports from other tenants", async () => {
    const manifest = await repository.createManifest(tenantA, `tlm_${randomUUID()}`, { name: "Private", ecosystem: "npm", trust_level: "unverified_private" });
    const version = await repository.createVersion(tenantA, `tlv_${randomUUID()}`, manifest.id, { version: "1.0.0", artifact_ref: "s3://bucket/private.tgz", capabilities: [], permissions: [] });
    await repository.beginScan(tenantA,manifest.id,version.id);
    await repository.completeScan(tenantA, manifest.id, version.id, `scn_${randomUUID()}`, { verdict: "blocked", findings: [], scannerVersion: "test", durationMs: 0, scannedAt: new Date().toISOString() });
    expect(await repository.get(tenantB, manifest.id)).toBeUndefined(); expect(await repository.latestReport(tenantB, version.id)).toBeUndefined();
  });
  it("denies unscoped reads and tenant write to first-party manifest", async () => {
    const id = `tlm_${randomUUID()}`;
    await admin.query(`INSERT INTO tool_manifests (id, tenant_id, name, ecosystem, trust_level) VALUES ($1, NULL, 'First party', 'npm', 'alter_verified')`, [id]);
    const client = await pool.connect(); try { await client.query("RESET app.current_tenant_id"); expect((await client.query("SELECT * FROM tool_manifests")).rows).toHaveLength(0); await client.query(`SET app.current_tenant_id = '${tenantA}'`); await expect(client.query(`UPDATE tool_manifests SET name = 'bad' WHERE id = $1`, [id])).resolves.toMatchObject({ rowCount: 0 }); } finally { client.release(); }
  });
  it("exposes a published third-party manifest and its versions to other tenants", async () => {
    const manifest = await repository.createManifest(tenantA, `tlm_${randomUUID()}`, { name: "Shared", ecosystem: "npm", trust_level: "community_reviewed" });
    const version = await repository.createVersion(tenantA, `tlv_${randomUUID()}`, manifest.id, { version: "1.0.0", artifact_ref: "s3://bucket/shared.tgz", capabilities: [], permissions: [] });
    await publishReviewed(manifest.id,version.id);
    expect(await repository.get(tenantB, manifest.id)).toBeDefined();
    expect((await repository.versions(tenantB, manifest.id)).map((item) => item.id)).toContain(version.id);
  });
  it("removes a manifest from catalogue when its final published version is revoked", async () => {
    const manifest = await repository.createManifest(tenantA, `tlm_${randomUUID()}`, { name: "Revoked", ecosystem: "mcp", trust_level: "community_reviewed" });
    const version = await repository.createVersion(tenantA, `tlv_${randomUUID()}`, manifest.id, { version: "1.0.0", artifact_ref: "s3://bucket/revoked.tgz", capabilities: [], permissions: [] });
    await publishReviewed(manifest.id,version.id);
    await repository.revoke(tenantA, `rvk_${randomUUID()}`, manifest.id, version.id, "Unsafe", "usr_1");
    expect((await repository.list(tenantB)).map((item) => item.id)).not.toContain(manifest.id);
  });
});
