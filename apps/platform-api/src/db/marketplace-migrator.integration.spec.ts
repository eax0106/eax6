import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMarketplaceMigrations } from "./marketplace-migrator";

// Whether the real SQL applies and reverses against real Postgres. The
// runner's decision logic -- what it applies, what it records, what it refuses
// -- is covered without a database in marketplace-migrator.spec.ts, so this
// file stays deliberately small: applying the migrations and unwinding
// them is heavy DDL (an extension, two generated columns, six GIN indexes),
// and every extra case is another full cycle competing with the other
// DB-backed specs in this target.

const databaseUrl = process.env.MARKETPLACE_DATABASE_URL ?? "";

const MARKETPLACE_TABLES = [
  "listings",
  "listing_versions",
  "installs",
  "reviews",
  "orders",
  "publishers",
  "kyc_submissions",
  "payouts",
  "payout_ledger",
  "tool_manifests",
  "tool_versions",
  "tool_scan_reports",
  "tool_revocations",
];

const TAGS = [
  "0000_marketplace_core",
  "0001_publisher_payout",
  "0002_tool_registry",
  "0003_search_indexes",
  "0004_scan_unavailable",
  "0005_listing_pricing",
  "0006_payout_ledger_erasure_guard",
  "0007_tool_version_review",
];

describe.skipIf(!databaseUrl)("marketplace migration runner", () => {
  let admin: pg.Client;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `migrator_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    // public stays on the path for the reason the repository specs keep it
    // there: 0003 pins pg_trgm to public.
    await admin.query(`SET search_path TO "${schemaName}", public`);
  });

  afterEach(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  async function tableCount(): Promise<number> {
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables
       WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
      [schemaName, MARKETPLACE_TABLES],
    );
    return Number(rows[0]?.count ?? "0");
  }

  async function ledger(): Promise<string[]> {
    const { rows } = await admin.query<{ tag: string }>(
      `SELECT "tag" FROM "marketplace_migrations" ORDER BY "tag"`,
    );
    return rows.map((row) => row.tag);
  }

  it("creates every marketplace table, records it, and re-runs clean", async () => {
    expect(await tableCount()).toBe(0);

    expect(await applyMarketplaceMigrations(admin)).toEqual(TAGS);
    expect(await tableCount()).toBe(MARKETPLACE_TABLES.length);
    expect(await ledger()).toEqual(TAGS);

    // Idempotent: this is what makes db:migrate safe to call on every deploy.
    expect(await applyMarketplaceMigrations(admin)).toEqual([]);
    expect(await tableCount()).toBe(MARKETPLACE_TABLES.length);
  }, 30_000);

  it("holds legacy publication for a recorded first-version review and reverses without inventing approval", async () => {
    await applyMarketplaceMigrations(admin);
    await applyMarketplaceMigrations(admin,{direction:"down",steps:1});
    const tenant=`ten_${randomUUID()}`;
    const versions:string[]=[];
    for (const [i,verdict] of (["clean","findings"] as const).entries()) {
      const manifest=`tlm_${randomUUID()}`,version=`tlv_${randomUUID()}`;versions.push(version);
      await admin.query("INSERT INTO tool_manifests(id,tenant_id,name,ecosystem,trust_level,status) VALUES($1,$2,$3,'npm','community_reviewed','published')",[manifest,tenant,`Legacy ${i}`]);
      await admin.query("INSERT INTO tool_versions(id,manifest_id,version,artifact_ref,capabilities_json,permissions_json,status,published_at) VALUES($1,$2,'1.0.0','s3://legacy','[]'::jsonb,'[]'::jsonb,'published',now())",[version,manifest]);
      await admin.query("INSERT INTO tool_scan_reports(id,tenant_id,tool_version_id,verdict,findings_json,scanner_version,duration_ms,scanned_at) VALUES($1,$2,$3,$4,$5::jsonb,'legacy',1,now())",[`scn_${randomUUID()}`,tenant,version,verdict,JSON.stringify(verdict==="clean"?[]:[{rule:"old",severity:"low",locator:"fixture",detail:"Old finding"}])]);
    }
    expect(await applyMarketplaceMigrations(admin)).toEqual(["0007_tool_version_review"]);
    const rows=await admin.query("SELECT id,status,published_at,latest_scan_report_id,review_decision FROM tool_versions WHERE id=ANY($1) ORDER BY id",[versions]);
    for (const row of rows.rows) { expect(row.status).toBe(row.id===versions[0]?"review_pending":"scan_failed");expect(row.published_at).toBeNull();expect(row.latest_scan_report_id).toMatch(/^scn_/);expect(row.review_decision).toBeNull(); }
    expect((await admin.query("SELECT status FROM tool_manifests WHERE tenant_id=$1",[tenant])).rows.map(row=>row.status)).toEqual(["draft","draft"]);
    await applyMarketplaceMigrations(admin,{direction:"down",steps:1});
    expect((await admin.query("SELECT status FROM tool_versions WHERE id=$1",[versions[0]])).rows[0].status).toBe("draft");
    expect((await admin.query("SELECT status FROM tool_manifests WHERE tenant_id=$1",[tenant])).rows.every(row=>row.status==="draft")).toBe(true);
  },30000);

  it("unwinds fully and can be applied again", async () => {
    await applyMarketplaceMigrations(admin);

    // Five steps first, so 0003's rollback -- the pair that did not exist
    // before this change -- is exercised on its own and its generated columns
    // checked while the tables it hangs off are still there.
    expect(
      await applyMarketplaceMigrations(admin, { direction: "down", steps: 5 }),
    ).toEqual(["0007_tool_version_review", "0006_payout_ledger_erasure_guard", "0005_listing_pricing", "0004_scan_unavailable", "0003_search_indexes"]);
    const columns = await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND column_name = 'search_document'`,
      [schemaName],
    );
    expect(columns.rows).toHaveLength(0);
    expect(await tableCount()).toBe(MARKETPLACE_TABLES.length);

    expect(
      await applyMarketplaceMigrations(admin, { direction: "down" }),
    ).toEqual([
      "0002_tool_registry",
      "0001_publisher_payout",
      "0000_marketplace_core",
    ]);
    expect(await tableCount()).toBe(0);
    expect(await ledger()).toEqual([]);

    // pg_trgm is shared with whatever else is mid-run, so a full unwind must
    // leave it alone (see the comment in 0003_drop_search_indexes.sql).
    const extension = await admin.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(extension.rows).toHaveLength(1);

    // A rollback set that cannot be followed by another apply is not a way
    // back out.
    expect(await applyMarketplaceMigrations(admin)).toEqual(TAGS);
    expect(await tableCount()).toBe(MARKETPLACE_TABLES.length);
  }, 30_000);
});
