import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMarketplaceMigrations } from "../db/marketplace-migrator";
import { AdminPublisherRepository } from "./admin-publisher.repository";
import { PublisherRepository } from "./publisher.repository";

const databaseUrl = process.env.MARKETPLACE_DATABASE_URL ?? "";
const documents = [
  { type: "tax_id" as const, objectRef: "s3://private/tax" },
  { type: "bank_proof" as const, objectRef: "s3://private/bank" },
];

// Task B2.4. The two roles have the privilege shape deploy/ec2/platform-db-roles.sql
// gives the host: the tenant plane is held to RLS, the staff plane bypasses it.
describe.skipIf(!databaseUrl)("Staff seller-verification review PostgreSQL (task B2.4)", () => {
  let admin: pg.Client;
  let appPool: pg.Pool;
  let operationsPool: pg.Pool;
  let tenantPlane: PublisherRepository;
  let staffPlane: AdminPublisherRepository;
  let schemaName: string;
  let appRole: string;
  let operationsRole: string;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll("-", "_");
    schemaName = `admin_publisher_${suffix}`;
    appRole = `admin_publisher_app_${suffix}`;
    operationsRole = `admin_publisher_ops_${suffix}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}", public`);
    await applyMarketplaceMigrations(admin);
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${appRole}" LOGIN NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE "${operationsRole}" LOGIN BYPASSRLS PASSWORD '${password}'`);
    for (const role of [appRole, operationsRole]) {
      await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${role}"`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${role}"`);
    }
    appPool = new pg.Pool({ connectionString: roleUrl(appRole, password) });
    operationsPool = new pg.Pool({ connectionString: roleUrl(operationsRole, password) });
    tenantPlane = new PublisherRepository(appPool);
    staffPlane = new AdminPublisherRepository(operationsPool);
  });

  afterEach(async () => {
    await appPool?.end();
    await operationsPool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      for (const role of [appRole, operationsRole]) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await admin.end();
    }
  });

  it("queues every tenant's pending submission for staff, oldest first, and drops a decided one", async () => {
    const first = await tenantPlane.createSubmission(tenantA, `pub_${randomUUID()}`, `kyc_${randomUUID()}`, documents);
    const second = await tenantPlane.createSubmission(tenantB, `pub_${randomUUID()}`, `kyc_${randomUUID()}`, documents);

    const queue = await staffPlane.listPending();
    expect(queue.map((item) => [item.id, item.tenant_id])).toEqual([[first.id, tenantA], [second.id, tenantB]]);
    expect(queue[0]!.documents).toEqual(documents);

    await expect(tenantPlane.reviewSubmission(tenantB, second.id, "stf_reviewer", "approved", null)).resolves.toMatchObject({ status: "approved" });
    await expect(tenantPlane.getPublisher(tenantB)).resolves.toMatchObject({ verificationStatus: "verified" });
    expect((await staffPlane.listPending()).map((item) => item.id)).toEqual([first.id]);
  });

  it("reviews only inside the submission's own tenant: the wrong tenant finds nothing", async () => {
    const pending = await tenantPlane.createSubmission(tenantA, `pub_${randomUUID()}`, `kyc_${randomUUID()}`, documents);
    await expect(tenantPlane.reviewSubmission(tenantB, pending.id, "stf_reviewer", "approved", null)).resolves.toBeUndefined();
    await expect(tenantPlane.getPublisher(tenantA)).resolves.toMatchObject({ verificationStatus: "pending_review" });
  });

  it("the tenant-plane role cannot read the cross-tenant queue", async () => {
    await tenantPlane.createSubmission(tenantA, `pub_${randomUUID()}`, `kyc_${randomUUID()}`, documents);
    await expect(new AdminPublisherRepository(appPool).listPending()).resolves.toEqual([]);
  });

  it("is unavailable, not empty, when the Operations pool is not configured", async () => {
    await expect(new AdminPublisherRepository(undefined).listPending()).rejects.toThrow(/OPERATIONS_MARKETPLACE_DATABASE_URL/);
  });

  function roleUrl(role: string, password: string): string {
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    return url.toString();
  }
});
