import { BillingOperationNotSubmittedError } from "@alterx/shared-clients";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BillingProvider, Subscription } from "@alterx/shared-clients";
import { PostgresPlanDefinitionStore } from "../entitlements/plan-definition-store";
import { BillingService } from "./billing.service";
import { BillingRepository } from "./billing.repository";
import { computeEtag } from "../concurrency/etag";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";

describe.skipIf(!databaseUrl)("BillingRepository PostgreSQL RLS", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: BillingRepository;
  let schemaName: string;
  let roleName: string;

  beforeEach(async () => {
    schemaName = `billing_${randomUUID().replaceAll("-", "_")}`;
    roleName = `billing_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    await admin.query(
      `INSERT INTO tenants (id, name, status)
       VALUES ($1, 'Tenant A', 'active'), ($2, 'Tenant B', 'active')`,
      [tenantA, tenantB],
    );

    await admin.query(`INSERT INTO staff_users (id,identity_ref,email,roles) VALUES ('stf_checkout','auth0|fixture-checkout','staff@example.test',ARRAY['staff_admin'])`);
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES
       IN SCHEMA "${schemaName}" TO "${roleName}"`,
    );
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    repository = new BillingRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  async function configuredPlan() {
    return (await new PostgresPlanDefinitionStore(pool).upsert("basic", {
      maxWorkflows: 3, maxProjects: 1, maxRunsPerDay: 10, maxConcurrentRuns: 1,
      maxSandboxMinutesPerMonth: 30, maxAdsStorageMb: 500, maxIntegrations: 3,
    }, "stf_checkout", { currency: "INR", basePriceMinor: 10003, razorpayPlanId: "plan_fixtureABC",
      includedCredits: 100, extraCreditPriceMinor: 50, creditsPerVerifiedRun: 2 }, "fixture configuration")).record;
  }

  const checkoutResource: Subscription = { id: "sub_fixtureABC", tenantId: tenantA, planId: "plan_fixtureABC",
    status: "created", currentPeriodStart: null, currentPeriodEnd: null, providerCustomerRef: null,
    checkoutUrl: "https://rzp.io/rzp/fixture" };

  it("claims one checkout under concurrency and durably binds the created result without granting paid access", async () => {
    const definition = await configuredPlan();
    let enter!: () => void, finish!: (value: Subscription) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const result = new Promise<Subscription>(resolve => { finish = resolve; });
    let calls = 0;
    const provider = { createCheckoutSubscription: async () => { calls++; enter(); return result; } } as unknown as BillingProvider;
    const service = new BillingService(repository,provider,new PostgresPlanDefinitionStore(pool));
    const input = { plan_id: definition.plan, plan_version: definition.updatedAt.toISOString(), gstin: "27ABCDE1234F1Z5" };
    const first = service.createSubscription(tenantA,input,"owner-fixture");
    await entered;
    await expect(service.createSubscription(tenantA,input,"owner-fixture")).rejects.toMatchObject({ response: { error_code: "BILLING_SUBSCRIPTION_EXISTS" } });
    finish(checkoutResource);
    expect(await first).toMatchObject({ planId: "basic", status: "created", checkoutUrl: checkoutResource.checkoutUrl });
    expect(calls).toBe(1);
    expect(await repository.getProfile(tenantA)).toMatchObject({ gstin: input.gstin, providerPlanRef: "plan_fixtureABC",
      currentPlan: "basic", subscriptionRef: "sub_fixtureABC", status: "created", checkoutAttemptId: null });
    expect(await repository.getProfile(tenantB)).toBeNull();
    const audits = await admin.query("SELECT reason,actor_ref FROM billing_dunning_audits WHERE tenant_id=$1 ORDER BY created_at",[tenantA]);
    expect(audits.rows).toEqual([{ reason: "checkout_claimed", actor_ref: "owner-fixture" }, { reason: "checkout_created", actor_ref: "owner-fixture" }]);
    expect((await admin.query("SELECT * FROM entitlements WHERE tenant_id=$1",[tenantA])).rows).toHaveLength(0);
  });

  it("refuses unset or changed plan configuration before provider calls and preserves a concurrent version", async () => {
    const definition = await configuredPlan();
    let calls = 0;
    const service = new BillingService(repository,{ createCheckoutSubscription: async () => { calls++; return checkoutResource; } } as unknown as BillingProvider,
      new PostgresPlanDefinitionStore(pool));
    await expect(service.createSubscription(tenantA,{ plan_id: "unset", plan_version: definition.updatedAt.toISOString() },"owner-fixture"))
      .rejects.toMatchObject({ response: { error_code: "BILLING_PLAN_UNCONFIGURED" } });
    await expect(service.createSubscription(tenantA,{ plan_id: "basic", plan_version: "2025-01-01T00:00:00.000Z" },"owner-fixture"))
      .rejects.toMatchObject({ response: { error_code: "BILLING_PLAN_CHANGED" } });
    await admin.query("UPDATE plan_definitions SET updated_at=updated_at+interval '1 second' WHERE plan='basic'");
    await expect(repository.claimCheckout(tenantA,"owner-fixture",definition)).rejects.toMatchObject({ response: { error_code: "BILLING_PLAN_CHANGED" } });
    expect(calls).toBe(0);
    expect(await repository.getProfile(tenantA)).toBeNull();
  });

  it("rolls a checkout claim back when its attributed audit cannot be persisted", async () => {
    const definition = await configuredPlan();
    await admin.query(`CREATE FUNCTION reject_checkout_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$;
      CREATE TRIGGER reject_checkout_audit BEFORE INSERT ON billing_dunning_audits
      FOR EACH ROW EXECUTE FUNCTION reject_checkout_audit();`);
    await expect(repository.claimCheckout(tenantA,"owner-fixture",definition)).rejects.toThrow("audit unavailable");
    expect(await repository.getProfile(tenantA)).toBeNull();
  });

  it("retains an unconfirmed provider operation and never blindly creates another subscription", async () => {
    const definition = await configuredPlan();
    let calls = 0;
    const service = new BillingService(repository,{ createCheckoutSubscription: async () => { calls++; throw new Error("provider timeout"); } } as unknown as BillingProvider,
      new PostgresPlanDefinitionStore(pool));
    const input = { plan_id: "basic", plan_version: definition.updatedAt.toISOString() };
    await expect(service.createSubscription(tenantA,input,"owner-fixture")).rejects.toMatchObject({ response: { error_code: "BILLING_PROVIDER_ERROR" } });
    expect(await repository.getProfile(tenantA)).toMatchObject({ status: "checkout_unconfirmed", subscriptionRef: null });
    await expect(service.getSubscription(tenantA)).rejects.toMatchObject({ response: { error_code: "BILLING_CHECKOUT_UNCONFIRMED" } });
    await expect(service.createSubscription(tenantA,input,"owner-fixture")).rejects.toMatchObject({ response: { error_code: "BILLING_SUBSCRIPTION_EXISTS" } });
    expect(calls).toBe(1);
  });

  it("releases only a known unsubmitted checkout claim, audits the failure and permits a fresh attempt", async () => {
    const definition=await configuredPlan();let calls=0;
    const provider={createCheckoutSubscription:async()=>{calls++;if(calls===1)throw new BillingOperationNotSubmittedError(new Error("Plan validation failed before POST"));return checkoutResource;}} as unknown as BillingProvider;
    const service=new BillingService(repository,provider,new PostgresPlanDefinitionStore(pool));
    const input={plan_id:"basic",plan_version:definition.updatedAt.toISOString()};
    await expect(service.createSubscription(tenantA,input,"owner-fixture")).rejects.toMatchObject({response:{error_code:"BILLING_PROVIDER_ERROR"}});
    expect(await repository.getProfile(tenantA)).toMatchObject({status:"checkout_failed",checkoutAttemptId:null,commercialSnapshot:null,gstin:null});
    expect((await admin.query("SELECT reason,actor_ref FROM billing_dunning_audits WHERE reason='checkout_not_submitted'")).rows).toEqual([{reason:"checkout_not_submitted",actor_ref:"owner-fixture"}]);
    await expect(service.createSubscription(tenantA,input,"owner-fixture")).resolves.toMatchObject({status:"created"});expect(calls).toBe(2);
  });

  it("recovers a lost checkout response through its persisted attempt without another POST or paid access", async () => {
    const definition=await configuredPlan();const attempts:string[]=[];
    const provider={createCheckoutSubscription:async(_tenant:string,_plan:string,input:{checkoutAttemptId:string})=>{
      attempts.push(input.checkoutAttemptId);throw new Error("response lost");
    },findCheckoutSubscription:async(_tenant:string,input:{checkoutAttemptId:string})=>{
      expect(input.checkoutAttemptId).toBe(attempts[0]);return checkoutResource;
    },getSubscription:async()=>({...checkoutResource,status:"active"})} as unknown as BillingProvider;
    const service=new BillingService(repository,provider,new PostgresPlanDefinitionStore(pool));
    await expect(service.createSubscription(tenantA,{plan_id:"basic",plan_version:definition.updatedAt.toISOString()},"owner-fixture")).rejects.toThrow();
    const before=await repository.getProfile(tenantA);expect(before?.checkoutStartedAt).toBeInstanceOf(Date);
    expect(await service.getSubscription(tenantA)).toMatchObject({id:checkoutResource.id,status:"created",planId:"basic"});
    expect(attempts).toHaveLength(1);expect((await repository.getProfile(tenantA))?.checkoutAttemptId).toBeNull();
    expect((await admin.query("SELECT * FROM entitlements WHERE tenant_id=$1",[tenantA])).rows).toEqual([]);
  });

  it("does not replace an authoritative callback when a delayed checkout response arrives", async () => {
    const definition=await configuredPlan(),attempt=await repository.claimCheckout(tenantA,"owner-fixture",definition);
    await repository.finishCheckout(tenantA,"system:checkout-recovery",attempt,checkoutResource);
    await admin.query("UPDATE billing_profiles SET status='active' WHERE tenant_id=$1",[tenantA]);
    expect(await repository.finishCheckout(tenantA,"owner-fixture",attempt,checkoutResource)).toMatchObject({status:"active"});
    await expect(repository.finishCheckout(tenantB,"owner-fixture",attempt,checkoutResource)).rejects.toMatchObject({response:{error_code:"BILLING_PROFILE_INCONSISTENT"}});
    expect((await admin.query("SELECT reason FROM billing_dunning_audits WHERE tenant_id=$1 AND reason='checkout_created'",[tenantA])).rows).toHaveLength(1);
  });

  async function activeSubscription() {
    const definition=await configuredPlan(),attempt=await repository.claimCheckout(tenantA,"owner-fixture",definition);
    await repository.finishCheckout(tenantA,"owner-fixture",attempt,checkoutResource);
    await admin.query("UPDATE billing_profiles SET status='active' WHERE tenant_id=$1",[tenantA]);
    return (await repository.getProfile(tenantA))!;
  }

  it("checks mutation If-Match against the locked row and never claims stale or missing versions", async () => {
    const profile=await activeSubscription(),etag=computeEtag({},profile.updatedAt.toISOString());
    await expect(repository.claimMutation(tenantA,"owner-fixture","cancel",undefined)).rejects.toMatchObject({response:{error_code:"PRECONDITION_REQUIRED"}});
    await expect(repository.claimMutation(tenantA,"owner-fixture","cancel",'"stale"')).rejects.toMatchObject({response:{error_code:"PRECONDITION_FAILED"}});
    const results=await Promise.allSettled(Array.from({length:5},()=>repository.claimMutation(tenantA,"owner-fixture","cancel",etag)));
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect((await repository.getProfile(tenantA))?.mutationKind).toBe("cancel");
    expect((await admin.query("SELECT reason,actor_ref FROM billing_dunning_audits WHERE reason='cancel_claimed'",[])).rows).toEqual([{reason:"cancel_claimed",actor_ref:"owner-fixture"}]);
    expect((await repository.getProfile(tenantB))).toBeNull();
  });

  it("keeps configured plan changes pending without overwriting the current snapshot or granting access", async () => {
    const profile=await activeSubscription(),definition=(await new PostgresPlanDefinitionStore(pool).upsert("pro",{
      maxWorkflows:10,maxProjects:5,maxRunsPerDay:50,maxConcurrentRuns:4,maxSandboxMinutesPerMonth:60,maxAdsStorageMb:1000,maxIntegrations:10,
    },"stf_checkout",{currency:"INR",basePriceMinor:20000,razorpayPlanId:"plan_pro",includedCredits:300,extraCreditPriceMinor:60,creditsPerVerifiedRun:3},"fixture change")).record;
    const claim=await repository.claimMutation(tenantA,"owner-fixture","change",computeEtag({},profile.updatedAt.toISOString()),definition);
    expect(claim).toMatchObject({currentPlan:"basic",providerPlanRef:"plan_fixtureABC",pendingPlan:"pro",pendingProviderPlanRef:"plan_pro",mutationKind:"change"});
    expect(claim.commercialSnapshot?.includedCredits).toBe(100);expect(claim.pendingCommercialSnapshot?.includedCredits).toBe(300);
    await expect(repository.confirmMutationResponse(tenantA,"owner-fixture",claim.mutationAttemptId!,{...checkoutResource,id:"sub_foreign",planId:"plan_pro"})).rejects.toMatchObject({response:{error_code:"BILLING_PROFILE_INCONSISTENT"}});
    expect(await repository.confirmMutationResponse(tenantA,"owner-fixture",claim.mutationAttemptId!,{...checkoutResource,planId:"plan_pro",status:"active"})).toMatchObject({currentPlan:"basic",pendingPlan:"pro"});
    expect((await admin.query("SELECT internal_plan FROM billing_subscription_plans WHERE tenant_id=$1",[tenantA])).rows).toEqual([{internal_plan:"basic"}]);
    expect((await admin.query("SELECT * FROM entitlements WHERE tenant_id=$1",[tenantA])).rows).toEqual([]);
  });

  it.each(["change","cancel"] as const)("releases known unsubmitted %s while unknown provider writes remain pending",async kind=>{
    let profile=await activeSubscription();const definitions=new PostgresPlanDefinitionStore(pool);
    const basic=(await definitions.find("basic"))!;
    await definitions.upsert("pro",basic.limits,"stf_checkout",{...basic.commercial!,razorpayPlanId:"plan_pro"},"fixture change");
    const pro=(await definitions.find("pro"))!;let unknown=false,calls=0;
    const operation=async()=>{calls++;throw unknown?new Error("Provider write response lost"):new BillingOperationNotSubmittedError(new Error("Preflight failed"));};
    const service=new BillingService(repository,{changeConfiguredSubscription:operation,cancelSubscription:operation} as unknown as BillingProvider,definitions);
    const act=()=>kind==="change"?service.changeSubscription(tenantA,{plan_id:"pro",plan_version:pro.updatedAt.toISOString()},"owner-fixture",computeEtag({},profile.updatedAt.toISOString())):service.cancelSubscription(tenantA,"owner-fixture",computeEtag({},profile.updatedAt.toISOString()));
    await expect(act()).rejects.toMatchObject({response:{error_code:"BILLING_PROVIDER_ERROR"}});
    expect(await repository.getProfile(tenantA)).toMatchObject({status:"active",currentPlan:"basic",mutationAttemptId:null,mutationKind:null,pendingPlan:null});
    expect((await admin.query("SELECT reason,actor_ref FROM billing_dunning_audits WHERE reason='mutation_not_submitted'")).rows).toEqual([{reason:"mutation_not_submitted",actor_ref:"owner-fixture"}]);
    profile=(await repository.getProfile(tenantA))!;unknown=true;await expect(act()).rejects.toMatchObject({response:{error_code:"BILLING_PROVIDER_ERROR"}});
    profile=(await repository.getProfile(tenantA))!;expect(profile.mutationKind).toBe(kind);
    await expect(act()).rejects.toMatchObject({response:{error_code:"BILLING_OPERATION_PENDING"}});expect(calls).toBe(2);
  });
  it("rolls a failed-operation claim release back with its audit and ignores foreign or stale attempts",async()=>{
    const definition=await configuredPlan(),attempt=await repository.claimCheckout(tenantA,"owner-fixture",definition);
    await repository.releaseUnsubmittedOperation(tenantB,"foreign",attempt,"checkout");
    await repository.releaseUnsubmittedOperation(tenantA,"stale",randomUUID(),"checkout");
    expect((await repository.getProfile(tenantA))?.checkoutAttemptId).toBe(attempt);
    await admin.query(`CREATE FUNCTION reject_release_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='checkout_not_submitted' THEN RAISE EXCEPTION 'release audit unavailable'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_release_audit BEFORE INSERT ON billing_dunning_audits FOR EACH ROW EXECUTE FUNCTION reject_release_audit();`);
    await expect(repository.releaseUnsubmittedOperation(tenantA,"owner-fixture",attempt,"checkout")).rejects.toThrow("release audit unavailable");
    expect(await repository.getProfile(tenantA)).toMatchObject({status:"checkout_creating",checkoutAttemptId:attempt});
  });

  it("rolls mutation and snapshot insertion back when the attributed audit fails", async () => {
    const profile=await activeSubscription();
    await admin.query(`CREATE FUNCTION reject_mutation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mutation audit unavailable'; END; $$;
      CREATE TRIGGER reject_mutation_audit BEFORE INSERT ON billing_dunning_audits FOR EACH ROW EXECUTE FUNCTION reject_mutation_audit();`);
    await expect(repository.claimMutation(tenantA,"owner-fixture","cancel",computeEtag({},profile.updatedAt.toISOString()))).rejects.toThrow("mutation audit unavailable");
    expect(await repository.getProfile(tenantA)).toMatchObject({mutationAttemptId:null,mutationKind:null,updatedAt:profile.updatedAt});
  });

  it("rejects unavailable provider capabilities and changed configuration before claiming a financial operation", async () => {
    const definitions=new PostgresPlanDefinitionStore(pool),definition=await configuredPlan();
    const service=new BillingService(repository,{} as BillingProvider,definitions);
    await expect(service.createSubscription(tenantA,{plan_id:"basic",plan_version:definition.updatedAt.toISOString()},"owner")).rejects.toMatchObject({status:503,response:{error_code:"BILLING_CHECKOUT_UNAVAILABLE"}});
    await expect(service.changeSubscription(tenantA,{plan_id:"unset",plan_version:definition.updatedAt.toISOString()},"owner",'*')).rejects.toMatchObject({status:503,response:{error_code:"BILLING_PLAN_UNCONFIGURED"}});
    await expect(service.changeSubscription(tenantA,{plan_id:"basic",plan_version:"2025-01-01T00:00:00.000Z"},"owner",'*')).rejects.toMatchObject({status:412,response:{error_code:"BILLING_PLAN_CHANGED"}});
    await expect(service.changeSubscription(tenantA,{plan_id:"basic",plan_version:definition.updatedAt.toISOString()},"owner",'*')).rejects.toMatchObject({status:503,response:{error_code:"BILLING_CHANGE_UNAVAILABLE"}});
    expect(await repository.getProfile(tenantA)).toBeNull();
  });

  it("refuses wrong tenant, invalid subscription identity, changed attempt or changed provider plan during checkout binding",async()=>{
    const definition=await configuredPlan(),attempt=await repository.claimCheckout(tenantA,"owner",definition);
    for(const resource of [{...checkoutResource,tenantId:tenantB},{...checkoutResource,id:"bad-id"}]) {
      await expect(repository.finishCheckout(tenantA,"owner",attempt,resource)).rejects.toMatchObject({status:502,response:{error_code:"BILLING_PROFILE_INCONSISTENT"}});
    }
    await expect(repository.finishCheckout(tenantA,"owner",randomUUID(),checkoutResource)).rejects.toMatchObject({status:409,response:{error_code:"BILLING_CHECKOUT_CHANGED"}});
    await expect(repository.finishCheckout(tenantA,"owner",attempt,{...checkoutResource,planId:"plan_foreign"})).rejects.toMatchObject({status:409});
    expect(await repository.getProfile(tenantA)).toMatchObject({subscriptionRef:null,checkoutAttemptId:attempt});
    await expect(repository.confirmMutationResponse(tenantB,"owner",randomUUID(),checkoutResource)).rejects.toMatchObject({status:502});
  });

  it("permits a fresh checkout after a terminal subscription, and does not clear pending changes by starting another purchase",async()=>{
    await activeSubscription();await admin.query("UPDATE billing_profiles SET status='cancelled' WHERE tenant_id=$1",[tenantA]);
    const definition=await configuredPlan(),attempt=await repository.claimCheckout(tenantA,"owner",definition);
    expect(await repository.getProfile(tenantA)).toMatchObject({status:"checkout_creating",subscriptionRef:null,checkoutAttemptId:attempt});
    await repository.finishCheckout(tenantA,"owner",attempt,checkoutResource);
    await admin.query("UPDATE billing_profiles SET status='active' WHERE tenant_id=$1",[tenantA]);
    const profile=(await repository.getProfile(tenantA))!;
    await repository.claimMutation(tenantA,"owner","cancel",computeEtag({},profile.updatedAt.toISOString()));
    await expect(repository.claimCheckout(tenantA,"owner",definition)).rejects.toMatchObject({status:409});
    const pending=(await repository.getProfile(tenantA))!;
    await expect(repository.claimMutation(tenantA,"owner","cancel",computeEtag({},pending.updatedAt.toISOString()))).rejects.toMatchObject({response:{error_code:"BILLING_OPERATION_PENDING"}});
  });

  it("rejects absent, terminal and non-active subscription changes and same-plan changes under the row lock",async()=>{
    await expect(repository.claimMutation(tenantA,"owner","cancel",'*')).rejects.toMatchObject({status:404});
    await activeSubscription();const definition=await configuredPlan();
    for(const status of ["cancelled","created"]){
      await admin.query("UPDATE billing_profiles SET status=$2 WHERE tenant_id=$1",[tenantA,status]);
      await expect(repository.claimMutation(tenantA,"owner","change",'*',definition)).rejects.toMatchObject({response:{error_code:"BILLING_SUBSCRIPTION_STATE"}});
    }
    await admin.query("UPDATE billing_profiles SET status='active' WHERE tenant_id=$1",[tenantA]);
    await expect(repository.claimMutation(tenantA,"owner","change",'*',definition)).rejects.toMatchObject({response:{error_code:"BILLING_PLAN_UNCHANGED"}});
    await admin.query("UPDATE plan_definitions SET updated_at=updated_at+interval '1 second' WHERE plan='basic'");
    await expect(repository.claimMutation(tenantA,"owner","change",'*',definition)).rejects.toMatchObject({response:{error_code:"BILLING_PLAN_CHANGED"}});
    expect((await repository.getProfile(tenantA))?.mutationAttemptId).toBeNull();
  });

  it("rejects provider read failures and foreign subscription resources without overwriting durable scope",async()=>{
    await activeSubscription();const definitions=new PostgresPlanDefinitionStore(pool);
    for(const resource of [null,{...checkoutResource,tenantId:tenantB},{...checkoutResource,id:"sub_foreign"},{...checkoutResource,planId:"plan_foreign"}]){
      const service=new BillingService(repository,{getSubscription:async()=>resource} as unknown as BillingProvider,definitions);
      await expect(service.getSubscription(tenantA)).rejects.toMatchObject({response:{error_code:"BILLING_PROFILE_INCONSISTENT"}});
    }
    expect((await repository.getProfile(tenantA))?.subscriptionRef).toBe(checkoutResource.id);
    expect((await repository.getProfile(tenantB))).toBeNull();
  });

  it("stores references only and enforces default-deny plus tenant isolation", async () => {
    await repository.setSubscriptionReferences(tenantA, {
      providerCustomerRef: "customer_tenant_a",
      subscriptionRef: "subscription_tenant_a",
    });
    await repository.savePaymentMethod(tenantA, {
      ref: "token_tenant_a",
      type: "card",
      brand: "Visa",
      last4: "4242",
    });

    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name IN ('billing_profiles', 'billing_payment_method_refs')`,
      [schemaName],
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        "card_number",
        "pan",
        "cvv",
        "provider_token",
        "api_key",
        "secret",
      ]),
    );

    const client = await pool.connect();
    try {
      await client.query("RESET app.current_tenant_id");
      expect((await client.query("SELECT * FROM billing_profiles")).rows).toHaveLength(
        0,
      );
      expect(
        (await client.query("SELECT * FROM billing_payment_method_refs")).rows,
      ).toHaveLength(0);

      await client.query(`SET app.current_tenant_id = '${tenantB}'`);
      expect((await client.query("SELECT * FROM billing_profiles")).rows).toHaveLength(
        0,
      );
      expect(
        (await client.query("SELECT * FROM billing_payment_method_refs")).rows,
      ).toHaveLength(0);

      await client.query(`SET app.current_tenant_id = '${tenantA}'`);
      expect((await client.query("SELECT * FROM billing_profiles")).rows).toHaveLength(
        1,
      );
      expect(
        (await client.query("SELECT * FROM billing_payment_method_refs")).rows,
      ).toHaveLength(1);
    } finally {
      client.release();
    }
  });
});

async function applyMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  const sql = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n--> statement-breakpoint\n");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
}
