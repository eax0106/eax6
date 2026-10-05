import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import pg from "pg";
import type { RecordEventRequest } from "@alterx/contracts";
import type { CreditPurchaseCheckout, CreditPurchaseProvider, CreditPurchaseProviderInput } from "@alterx/shared-clients";
import { CreditPurchaseRepository } from "../credit-purchase.repository";
import { CreditPurchaseService } from "../credit-purchase.service";
import { BillingWebhookRepository } from "../../billing/billing-webhook.repository";

export async function createCreditPurchaseNativeDriver(databaseUrl: string) {
  const schema = `credit_purchase_${randomUUID().replaceAll("-", "_")}`;
  const role = `credit_role_${randomUUID().replaceAll("-", "_")}`;
  const admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
  const directory = join(__dirname, "../../db/migrations");
  for (const file of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(join(directory, file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(statement);
  }
  const tenantA = uuidv7(), tenantB = uuidv7(), userA = uuidv7(), userB = uuidv7();
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Tenant A','active'),($2,'Tenant B','active')", [tenantA, tenantB]);
  await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,'auth0|purchase-a','a@example.test','active'),($2,'auth0|purchase-b','b@example.test','active')", [userA, userB]);
  await admin.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'owner'),($4,$5,$6,'owner')", [uuidv7(), tenantA, userA, uuidv7(), tenantB, userB]);
  await admin.query("INSERT INTO billing_profiles(id,tenant_id,provider_id,status,current_plan) VALUES($1,$2,'razorpay','active','basic'),($3,$4,'razorpay','active','basic')", [uuidv7(), tenantA, uuidv7(), tenantB]);
  await admin.query("INSERT INTO entitlements(id,tenant_id,plan,access_state,effective_from) VALUES($1,$2,'basic','active',clock_timestamp()),($3,$4,'basic','active',clock_timestamp())", [uuidv7(), tenantA, uuidv7(), tenantB]);
  await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_purchase','auth0|purchase-staff','staff@example.test',ARRAY['staff_admin'])");
  const limits = { maxWorkflows: 3, maxProjects: 1, maxRunsPerDay: 10, maxConcurrentRuns: 1, maxSandboxMinutesPerMonth: 30, maxAdsStorageMb: 500, maxIntegrations: 3 };
  const commercial = { currency: "INR", basePriceMinor: 10000, razorpayPlanId: "plan_fixtureABC", includedCredits: 100, extraCreditPriceMinor: 50, creditsPerVerifiedRun: 2 };
  const configured = await admin.query<{ updated_at: Date }>("INSERT INTO plan_definitions(plan,limits,commercial,updated_by) VALUES('basic',$1::jsonb,$2::jsonb,'stf_purchase') RETURNING updated_at", [JSON.stringify(limits), JSON.stringify(commercial)]);
  const password = randomUUID();
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await admin.query(`GRANT EXECUTE ON FUNCTION list_due_credit_purchases(integer),erase_tenant_credit_purchases(uuid,text) TO "${role}"`);
  const url = new URL(databaseUrl); url.username = role; url.password = password; url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.href });
  const repository = new CreditPurchaseRepository(pool), webhook = new BillingWebhookRepository(pool);
  const audits: RecordEventRequest[] = [], providerInputs: CreditPurchaseProviderInput[] = [];
  let auditHash = "a".repeat(64), failAudit = false, failCreate = false, creates = 0, reads = 0, synchronizeCalls = 0;
  let checkout: CreditPurchaseCheckout | null = null;
  const provider: CreditPurchaseProvider = {
    create: async input => {
      creates++; providerInputs.push(input);
      checkout = { id: `plink_${randomUUID().replaceAll("-", "")}`, referenceId: input.purchaseId, tenantId: input.tenantId,
        amountMinor: input.quote.totalMinor, amountPaidMinor: 0, currency: "INR", status: "created", checkoutUrl: "https://rzp.io/rzp/native", payments: [] };
      if (failCreate) throw new Error("Provider response lost after creation"); return checkout;
    },
    get: async () => { reads++; if (!checkout) throw new Error("Provider checkout unavailable"); return checkout; },
    find: async () => { reads++; return checkout; },
  };
  const service = new CreditPurchaseService(repository, provider, { record: async input => {
    audits.push(input); if (failAudit) throw new Error("Audit unavailable"); return { id: `aud_${uuidv7()}`, entry_hash: auditHash };
  } }, { synchronize: async () => { synchronizeCalls++; } }, webhook);
  return { schema, role, admin, pool, repository, webhook, provider, service, tenantA, tenantB, userA, userB, audits, providerInputs,
    input: { credits: 3, plan_version: configured.rows[0]!.updated_at.toISOString(), gstin: "27ABCDE1234F1Z5" },
    tenant: `ten_${tenantA}`, user: `usr_${userA}`, otherTenant: `ten_${tenantB}`, otherUser: `usr_${userB}`,
    get checkout() { return checkout; }, set checkout(value: CreditPurchaseCheckout | null) { checkout = value; },
    get creates() { return creates; }, get reads() { return reads; }, get synchronizes() { return synchronizeCalls; },
    set failCreate(value: boolean) { failCreate = value; }, set failAudit(value: boolean) { failAudit = value; }, set auditHash(value: string) { auditHash = value; },
    async close() { service.onModuleDestroy(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP ROLE IF EXISTS "${role}"`); await admin.end(); },
  };
}
export type CreditPurchaseNativeDriver = Awaited<ReturnType<typeof createCreditPurchaseNativeDriver>>;
