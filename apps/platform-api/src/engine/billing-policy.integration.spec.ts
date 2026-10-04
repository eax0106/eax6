import { ETAG_RESOURCE_RESOLVER } from "../concurrency";
import { computeEtag } from "../concurrency/etag";
import { BillingEtagResolver } from "../billing/billing-etag.resolver";
import { RazorpayBillingProvider } from "@alterx/adapters";
import type { SecretsProvider } from "@alterx/shared-clients";
import { Test } from "@nestjs/testing";
import { FastifyAdapter,type NestFastifyApplication } from "@nestjs/platform-fastify";
import { BillingController } from "../billing/billing.controller";
import { BillingService } from "../billing/billing.service";
import { BillingRepository } from "../billing/billing.repository";
import { BillingWebhookService } from "../billing/billing-webhook.service";
import { BillingWebhookRepository } from "../billing/billing-webhook.repository";
import { PgIdempotencyStore } from "../idempotency";
import { fork,type ChildProcess } from "node:child_process";
import { createHmac,randomUUID } from "node:crypto";
import { readdirSync,readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { PostgresPlanDefinitionStore } from "../entitlements/plan-definition-store";
import { InternalEntitlementProvider } from "../entitlements/internal-entitlement-provider";
import { PostgresEntitlementStore } from "../entitlements/entitlement-store";
import { LocalFileConfigProvider } from "../entitlements/adapters/local-file/local-file-config-provider";
import { PlanDefinitionConfigProvider } from "../entitlements/plan-definition-config-provider";
import { BillingPolicyService } from "../billing/billing-policy.service";
import { BillingPolicyClient } from "./billing-policy-client";
const databaseUrl=process.env.DATABASE_URL??"",tenant="00000000-0000-7000-8000-000000000001",other="00000000-0000-7000-8000-000000000002",user="00000000-0000-7000-8000-000000000003";
const token="native-billing-only-token";
describe.skipIf(!databaseUrl).sequential("durable platform billing publication to separately launched native engine",()=>{
  let admin:pg.Client,pool:pg.Pool,schema:string,role:string,driver:ChildProcess,baseUrl:string;
  let definitions:PostgresPlanDefinitionStore,entitlements:InternalEntitlementProvider,policy:BillingPolicyService,client:BillingPolicyClient;
  let interruptGrant=false,seenInterrupt=false;
  let app: NestFastifyApplication;
  const webhookSecret="native-billing-signature-fixture";
  beforeAll(async()=>{
    driver=fork(resolve("apps/orchestration-service/src/billing/testing/billing-native-driver.ts"),[],{execArgv:["--import",require.resolve("tsx")],env:{...process.env,NODE_ENV:"test",TSX_TSCONFIG_PATH:resolve("apps/orchestration-service/tsconfig.app.json")},silent:true});
    const ready=new Promise<string>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error("Native billing driver timed out")),120000);driver.once("message",(message:{ready?:string;error?:string})=>{clearTimeout(timer);if(message.ready)accept(message.ready);else reject(new Error(message.error));});driver.once("exit",()=>{clearTimeout(timer);reject(new Error("Native billing driver exited"));});});
    driver.send({token});baseUrl=await ready;
    schema=`billing_policy_${randomUUID().replaceAll("-","_")}`;role=`billing_policy_${randomUUID().replaceAll("-","_")}`;
    admin=new pg.Client({connectionString:databaseUrl});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);
    const directory=resolve("apps/platform-api/src/db/migrations");
    for(const name of readdirSync(directory).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(directory,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
    const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT platform_api TO ${role}`);
    const uri=new URL(databaseUrl);uri.username=role;uri.password=password;uri.searchParams.set("options",`-c search_path=${schema}`);pool=new pg.Pool({connectionString:uri.href});
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Billing A','active'),($2,'Billing B','active')",[tenant,other]);await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,'auth0|billing-native','native@example.test','active')",[user]);await admin.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES(gen_random_uuid(),$1,$2,'owner')",[tenant,user]);
    await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_billing','auth0|billing-staff','staff@example.test',ARRAY['staff_admin'])");
    definitions=new PostgresPlanDefinitionStore(pool);const config=new PlanDefinitionConfigProvider(new LocalFileConfigProvider(),definitions);
    entitlements=new InternalEntitlementProvider(new PostgresEntitlementStore(pool),config);
    client=new BillingPolicyClient(baseUrl,async()=>token,async(url,init)=>{
      const response=await fetch(url,init);
      if(interruptGrant&&String(url).endsWith("/grant")&&!seenInterrupt){seenInterrupt=true;throw new Error("Native response lost after engine committed");}
      return response;
    });
    policy=new BillingPolicyService(pool,config,definitions,client,entitlements);
    const repository=new BillingRepository(pool),secrets={getSecret:async()=>webhookSecret} as unknown as SecretsProvider;
    const provider=new RazorpayBillingProvider({keyIdSecretRef:"native-key",keySecretSecretRef:"native-secret"},secrets,repository);
    const webhook=new BillingWebhookService(provider,secrets,"native-webhook",new PgIdempotencyStore(pool,3600000),new BillingWebhookRepository(pool),entitlements,config,policy);
    const service=new BillingService(repository,provider,definitions);
    const module=await Test.createTestingModule({controllers:[BillingController],providers:[{provide:BillingService,useValue:service},{provide:BillingWebhookService,useValue:webhook},
      {provide:PgIdempotencyStore,useValue:new PgIdempotencyStore(pool,3600000)},
      {provide:ETAG_RESOURCE_RESOLVER,useValue:new BillingEtagResolver(service)},
    ]}).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(),{rawBody:true,logger:false});await app.init();await app.getHttpAdapter().getInstance().ready();
  },180000);
  beforeEach(()=>{interruptGrant=false;seenInterrupt=false;});
  afterAll(async()=>{
    if(driver?.connected){const exited=new Promise<void>(accept=>driver.once("exit",()=>accept()));driver.disconnect();await exited;}
    await app?.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}
  },60000);
  const query=async(sql:string,values:unknown[]=[])=>{const tx=await pool.connect();try{await tx.query("BEGIN");await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);const result=await tx.query(sql,values);await tx.query("COMMIT");return result;}catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}};
  it("rejects ordinary or unrelated service tokens and malformed internal writes",async()=>{
    for(const authorization of [undefined,"Bearer ordinary-user","Bearer unrelated-system-token"]){const response=await fetch(`${baseUrl}/internal/billing/policy`,{method:"POST",headers:{"content-type":"application/json",...(authorization?{authorization}:{})},body:JSON.stringify({tenantId:`ten_${tenant}`})});expect(response.status).toBe(401);}
    expect((await fetch(`${baseUrl}/internal/billing/grant`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({tenantId:`ten_${tenant}`,eventRef:"bad",credits:1.5})})).status).toBe(400);
  });
  it("binds verified identity to an actual active membership and publishes free admission policy",async()=>{
    await expect(policy.recordVerifiedIdentity(other,user)).rejects.toThrow("no active tenant membership");await entitlements.createEntitlement(tenant,"free");await policy.recordVerifiedIdentity(tenant,user);await policy.synchronize(tenant);
    const state=(await query("SELECT email_verified,verified_by,source_revision,published_revision,policy_payload FROM billing_policy_state")).rows[0];expect(state).toMatchObject({email_verified:true,verified_by:user,policy_payload:{tenantId:`ten_${tenant}`,plan:"free",free:true,emailVerified:true,creditsPerVerifiedRun:null,maxRunsPerDay:10}});expect(state.published_revision).toEqual(state.source_revision);
    expect(await client.account(tenant)).toEqual({balance:"0",reserved:"0",available:"0"});
    const inventory=await pool.query("SELECT tenant_id FROM list_billing_sync_tenants(NULL,100)");expect(inventory.rows).toEqual([{tenant_id:tenant}]);
  });
  it("retries a lost grant response without duplicating credits and preserves balance during policy changes",async()=>{
    await policy.recordVerifiedIdentity(tenant,user);
    await definitions.upsert("basic",{maxWorkflows:3,maxProjects:1,maxRunsPerDay:25,maxConcurrentRuns:1,maxSandboxMinutesPerMonth:30,maxAdsStorageMb:500,maxIntegrations:3},"stf_billing",{currency:"INR",basePriceMinor:10000,razorpayPlanId:"plan_native",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2},"native configured billing");
    await entitlements.createEntitlement(tenant,"basic");
    await query("INSERT INTO billing_credit_deliveries(tenant_id,payment_ref,credits,provider_event_id) VALUES($1,'pay_native',100,'evt_native')",[tenant]);
    interruptGrant=true;await expect(policy.synchronize(tenant)).rejects.toThrow("response lost");
    expect((await query("SELECT published_at FROM billing_credit_deliveries")).rows[0]).toEqual({published_at:null});expect(await client.account(tenant)).toEqual({balance:"100",reserved:"0",available:"100"});
    await policy.synchronize(tenant);expect((await query("SELECT published_at FROM billing_credit_deliveries")).rows[0].published_at).toBeInstanceOf(Date);expect(await client.account(tenant)).toEqual({balance:"100",reserved:"0",available:"100"});
    await entitlements.createEntitlement(tenant,"free");await policy.synchronize(tenant);expect(await client.account(tenant)).toEqual({balance:"100",reserved:"0",available:"100"});
  });
  async function boundSubscription() {
    const definition=(await definitions.upsert("basic",{maxWorkflows:3,maxProjects:1,maxRunsPerDay:25,maxConcurrentRuns:1,maxSandboxMinutesPerMonth:30,maxAdsStorageMb:500,maxIntegrations:3},"stf_billing",{currency:"INR",basePriceMinor:10000,razorpayPlanId:"plan_native",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2},"native configured billing")).record;
    await entitlements.createEntitlement(tenant,"free");await policy.recordVerifiedIdentity(tenant,user);
    await query(`INSERT INTO billing_profiles(tenant_id,id,provider_id,subscription_ref,status,current_plan,provider_plan_ref,commercial_snapshot)
      VALUES($1,gen_random_uuid(),'razorpay','sub_native','created','basic','plan_native',$2::jsonb)
      ON CONFLICT(tenant_id) DO UPDATE SET subscription_ref='sub_native',status='created',current_plan='basic',provider_plan_ref='plan_native',commercial_snapshot=$2::jsonb,checkout_attempt_id=NULL,last_provider_event_at=0,
        mutation_attempt_id=NULL,mutation_kind=NULL,pending_plan=NULL,pending_provider_plan_ref=NULL,pending_commercial_snapshot=NULL`,[tenant,JSON.stringify(definition.commercial)]);
    await query("DELETE FROM billing_dunning_states");
    return definition;
  }
  function payload(type:string,options:{timestamp?:number;subscriptionId?:string;plan?:string;tenantId?:string;paymentId?:string;amount?:number;attempt?:string}={}) {
    return JSON.stringify({account_id:"acc_native",event:type,created_at:options.timestamp??Math.floor(Date.now()/1000),payload:{
      subscription:{entity:{id:options.subscriptionId??"sub_native",plan_id:options.plan??"plan_native",status:type==="subscription.cancelled"?"cancelled":type==="subscription.pending"?"pending":"active",notes:{tenant_id:options.tenantId??tenant,...(options.attempt?{alter_checkout_attempt:options.attempt}:{})}}},
      ...(options.paymentId?{payment:{entity:{id:options.paymentId,status:"captured",amount:options.amount??11800,currency:"INR"}}}:{}),
    }});
  }
  const receive=(body:string,eventId=uuidEvent(),signature=createHmac("sha256",webhookSecret).update(body).digest("hex"))=>app.inject({method:"POST",url:"/api/v1/billing/webhooks/razorpay",headers:{"content-type":"application/json","x-razorpay-signature":signature,"x-razorpay-event-id":eventId},payload:body});
  const uuidEvent=()=>`native_${randomUUID()}`;
  it("uses actual signed raw HTTP for activation and credits one captured payment across event duplicates",async()=>{
    await boundSubscription();await policy.synchronize(tenant);const before=BigInt((await client.account(tenant)).balance);
    const body=payload("subscription.activated",{paymentId:"pay_signednative"}),eventId=uuidEvent();
    const first=await receive(body,eventId);expect(first.statusCode).toBe(202);expect(first.json()).toMatchObject({state:"active",replayed:false});
    expect((await receive(body,eventId)).json()).toMatchObject({replayed:true});expect((await receive(payload("subscription.charged",{paymentId:"pay_signednative"}))).statusCode).toBe(202);
    expect((await query("SELECT payment_ref,credits FROM billing_credit_deliveries WHERE payment_ref='pay_signednative'")).rows).toEqual([{payment_ref:"pay_signednative",credits:100}]);
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("basic");expect((await query("SELECT status,current_plan FROM billing_profiles")).rows[0]).toEqual({status:"active",current_plan:"basic"});
    await policy.synchronize(tenant);expect((await client.account(tenant)).balance).toBe(String(before+100n));
  });
  it("signed cancellation restores free access and neither stale nor later activation reopens a terminal subscription",async()=>{
    await boundSubscription();const timestamp=Math.floor(Date.now()/1000);
    expect((await receive(payload("subscription.activated",{timestamp}))).statusCode).toBe(202);
    expect((await receive(payload("subscription.cancelled",{timestamp}))).statusCode).toBe(202);
    for(const createdAt of [timestamp-1,timestamp+1])expect((await receive(payload("subscription.activated",{timestamp:createdAt}))).statusCode).toBe(202);
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("free");expect((await query("SELECT status FROM billing_profiles")).rows[0]).toEqual({status:"cancelled"});
  });
  it("signed callback binds an exact unconfirmed checkout before its delayed response and rejects another attempt",async()=>{
    await boundSubscription();const attempt=randomUUID();
    await query("UPDATE billing_profiles SET subscription_ref=NULL,status='checkout_unconfirmed',checkout_attempt_id=$2,checkout_started_at=clock_timestamp() WHERE tenant_id=$1",[tenant,attempt]);
    expect((await receive(payload("subscription.activated",{attempt:randomUUID()}))).statusCode).toBe(503);
    expect((await query("SELECT subscription_ref,checkout_attempt_id FROM billing_profiles")).rows[0]).toEqual({subscription_ref:null,checkout_attempt_id:attempt});
    expect((await receive(payload("subscription.activated",{attempt}))).statusCode).toBe(202);
    expect((await query("SELECT subscription_ref,checkout_attempt_id,status FROM billing_profiles")).rows[0]).toEqual({subscription_ref:"sub_native",checkout_attempt_id:null,status:"active"});
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("basic");
    expect((await query("SELECT reason FROM billing_dunning_audits WHERE provider_event_id=$1",[`checkout:${attempt}`])).rows).toEqual([{reason:"checkout_bound_by_provider"}]);
  });
  it("late captured payment grants credits once after cancellation without reopening access",async()=>{
    await boundSubscription();await policy.synchronize(tenant);const before=BigInt((await client.account(tenant)).balance),timestamp=Math.floor(Date.now()/1000);
    expect((await receive(payload("subscription.cancelled",{timestamp}))).statusCode).toBe(202);
    const charge=payload("subscription.charged",{timestamp:timestamp-1,paymentId:"pay_latecancel"});
    for(let i=0;i<2;i++)expect((await receive(charge)).statusCode).toBe(202);
    await policy.synchronize(tenant);expect((await client.account(tenant)).balance).toBe(String(before+100n));
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("free");expect((await query("SELECT status FROM billing_profiles")).rows[0]).toEqual({status:"cancelled"});
  });
  it("signed plan update promotes only its pending mapping and delayed old invoice keeps its original credit quantity",async()=>{
    await boundSubscription();const timestamp=Math.floor(Date.now()/1000);
    expect((await receive(payload("subscription.activated",{timestamp}))).statusCode).toBe(202);
    const definition=(await definitions.upsert("pro",{maxWorkflows:10,maxProjects:5,maxRunsPerDay:100,maxConcurrentRuns:4,maxSandboxMinutesPerMonth:120,maxAdsStorageMb:2000,maxIntegrations:10},"stf_billing",
      {currency:"INR",basePriceMinor:20000,razorpayPlanId:"plan_nativepro",includedCredits:300,extraCreditPriceMinor:50,creditsPerVerifiedRun:3},"native plan change")).record;
    const repository=new BillingRepository(pool),profile=(await repository.getProfile(tenant))!;
    await repository.claimMutation(tenant,user,"change",computeEtag({},profile.updatedAt.toISOString()),definition);
    await policy.synchronize(tenant);const before=BigInt((await client.account(tenant)).balance);
    expect((await receive(payload("subscription.updated",{timestamp,plan:"plan_nativepro"}))).statusCode).toBe(202);
    expect((await repository.getProfile(tenant))).toMatchObject({currentPlan:"pro",providerPlanRef:"plan_nativepro",mutationAttemptId:null});
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("pro");
    const oldCharge=payload("subscription.charged",{timestamp:timestamp-1,paymentId:"pay_oldplannative"});
    expect((await receive(oldCharge)).statusCode).toBe(202);expect((await receive(oldCharge)).statusCode).toBe(202);
    expect((await receive(payload("subscription.charged",{timestamp,plan:"plan_nativepro",paymentId:"pay_newplannative",amount:23600}))).statusCode).toBe(202);
    await policy.synchronize(tenant);expect((await client.account(tenant)).balance).toBe(String(before+400n));
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("pro");
  });
  it("signed cancellation settles a pending cancellation and leaves no unresolved mutation",async()=>{
    await boundSubscription();const timestamp=Math.floor(Date.now()/1000);
    expect((await receive(payload("subscription.activated",{timestamp}))).statusCode).toBe(202);
    const repository=new BillingRepository(pool),profile=(await repository.getProfile(tenant))!;
    await repository.claimMutation(tenant,user,"cancel",computeEtag({},profile.updatedAt.toISOString()));
    expect((await receive(payload("subscription.cancelled",{timestamp}))).statusCode).toBe(202);
    expect(await repository.getProfile(tenant)).toMatchObject({status:"cancelled",mutationAttemptId:null,mutationKind:null});
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("free");
  });
  it("elapsed dunning advances actual entitlement and engine admission without another failed payment event",async()=>{
    await boundSubscription();const timestamp=Math.floor(Date.now()/1000);
    expect((await receive(payload("subscription.activated",{timestamp}))).statusCode).toBe(202);
    expect((await receive(payload("subscription.pending",{timestamp}))).statusCode).toBe(202);
    expect((await entitlements.getEffectiveEntitlement(tenant)).accessState).toBe("grace");
    const config=await new LocalFileConfigProvider().getDunningConfig();
    await query("UPDATE billing_dunning_states SET first_failed_at=clock_timestamp()-($2::double precision * interval '1 second') WHERE tenant_id=$1",[tenant,config.gracePeriodSeconds+1]);
    await policy.synchronize(tenant);expect((await entitlements.getEffectiveEntitlement(tenant)).accessState).toBe("limited");
    expect((await query("SELECT policy_payload FROM billing_policy_state")).rows[0].policy_payload).toMatchObject({accessState:"limited",maxRunsPerDay:config.limitedStateLimits.maxRunsPerDay});
    await query("UPDATE billing_dunning_states SET first_failed_at=clock_timestamp()-($2::double precision * interval '1 second') WHERE tenant_id=$1",[tenant,config.suspensionThresholdSeconds+1]);
    await policy.synchronize(tenant);await policy.synchronize(tenant);
    expect((await entitlements.getEffectiveEntitlement(tenant)).accessState).toBe("suspended");
    expect((await query("SELECT reason,to_state FROM billing_dunning_audits WHERE reason='dunning_elapsed' ORDER BY created_at")).rows).toEqual([{reason:"dunning_elapsed",to_state:"limited"},{reason:"dunning_elapsed",to_state:"suspended"}]);
    expect((await receive(payload("subscription.activated",{timestamp:timestamp+1}))).statusCode).toBe(202);
    await policy.synchronize(tenant);expect((await entitlements.getEffectiveEntitlement(tenant)).accessState).toBe("active");
  });
  it("signed foreign subscriptions and plans cannot activate configured access; unbound tenant asks for retry",async()=>{
    await boundSubscription();
    for(const options of [{subscriptionId:"sub_foreign"},{plan:"plan_foreign"}])expect((await receive(payload("subscription.activated",options))).statusCode).toBe(202);
    expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("free");expect((await query("SELECT status FROM billing_profiles")).rows[0]).toEqual({status:"created"});
    expect((await receive(payload("subscription.activated",{tenantId:other}))).statusCode).toBe(503);
  });
  it("bad signature and mismatched payment amount leave no processed event, entitlement or credits",async()=>{
    await boundSubscription();const eventId=uuidEvent(),body=payload("subscription.charged",{paymentId:"pay_wrongamount",amount:1});
    expect((await receive(body,eventId,"forged")).statusCode).toBe(401);expect((await receive(body,eventId)).statusCode).toBe(400);
    expect((await query("SELECT * FROM billing_events WHERE provider_event_id=$1",[eventId])).rows).toEqual([]);expect((await query("SELECT * FROM billing_credit_deliveries WHERE payment_ref='pay_wrongamount'")).rows).toEqual([]);expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("free");
  });
  it("a failed attributed transition rolls back receipt and entitlement; identical delivery succeeds after repair",async()=>{
    await boundSubscription();const eventId=uuidEvent(),body=payload("subscription.activated");
    await admin.query(`CREATE FUNCTION native_reject_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native billing audit unavailable';END;$$;CREATE TRIGGER native_billing_audit_failure BEFORE INSERT ON billing_dunning_audits FOR EACH ROW EXECUTE FUNCTION native_reject_billing_audit()`);
    try{expect((await receive(body,eventId)).statusCode).toBe(500);expect((await query("SELECT * FROM billing_events WHERE provider_event_id=$1",[eventId])).rows).toEqual([]);expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("free");}
    finally{await admin.query("DROP TRIGGER native_billing_audit_failure ON billing_dunning_audits;DROP FUNCTION native_reject_billing_audit()");}
    expect((await receive(body,eventId)).statusCode).toBe(202);expect((await entitlements.getEffectiveEntitlement(tenant)).plan).toBe("basic");
  });

});
