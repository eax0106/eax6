import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BillingPolicyClient } from "../engine/billing-policy-client";
import { BillingPolicyService } from "../billing/billing-policy.service";
import { PostgresPlanDefinitionStore } from "../entitlements/plan-definition-store";
import { PlanDefinitionConfigProvider } from "../entitlements/plan-definition-config-provider";
import { LocalFileConfigProvider } from "../entitlements/adapters/local-file/local-file-config-provider";
import { InternalEntitlementProvider } from "../entitlements/internal-entitlement-provider";
import { PostgresEntitlementStore } from "../entitlements/entitlement-store";
import { CreditPurchaseService, etag } from "./credit-purchase.service";
import { createCreditPurchaseNativeDriver, type CreditPurchaseNativeDriver } from "./testing/credit-purchase-native-driver";

const requireBuilt=createRequire(resolve("package.json"));
const {BillingAccountController,BILLING_SYNC_TOKEN_HASH}=requireBuilt(resolve("dist/apps/orchestration-service/billing/billing-account.controller.js"));
const {EngineBillingAccountService}=requireBuilt(resolve("dist/apps/orchestration-service/billing/billing-account.service.js"));
const database=process.env.DATABASE_URL;
describe.skipIf(!database)("extra-credit delivery actual authenticated Engine and ordinary PostgreSQL",()=>{
  let container:StartedPostgreSqlContainer,admin:PostgresOrchestrationStoreProvider,store:PostgresOrchestrationStoreProvider,app:NestFastifyApplication;
  let d:CreditPurchaseNativeDriver,service:CreditPurchaseService,policy:BillingPolicyService,client:BillingPolicyClient;
  let dropAck=false,invalidAck=false,validCredential=true;
  const credential=randomBytes(24).toString("hex"),grants:string[]=[];
  beforeAll(async()=>{
    container=await new PostgreSqlContainer("postgres:16-alpine").withStartupTimeout(120_000).start();
    const migrationsFolder=resolve("apps/orchestration-service/drizzle");
    admin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:container.getConnectionUri(),migrationsFolder});await admin.migrate();
    const password=randomUUID();await admin.withTenant("00000000-0000-7000-8000-000000000001",async tx=>{
      await tx.query(`CREATE ROLE purchase_engine LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query("GRANT USAGE ON SCHEMA public TO purchase_engine; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO purchase_engine");
    });
    const url=new URL(container.getConnectionUri());url.username="purchase_engine";url.password=password;
    store=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:url.href,migrationsFolder});
    const engine=new EngineBillingAccountService(store);
    const module=await Test.createTestingModule({controllers:[BillingAccountController],providers:[{provide:EngineBillingAccountService,useValue:engine},
      {provide:BILLING_SYNC_TOKEN_HASH,useValue:createHash("sha256").update(credential).digest("hex")}]}).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.listen(0,"127.0.0.1");
    client=new BillingPolicyClient(await app.getUrl(),async()=>validCredential?credential:"invalid-purchase-credential",async(input,init)=>{
      // eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- drop only the response after the actual Engine HTTP grant has committed.
      const response=await fetch(input,init);
      if(String(input).endsWith("/grant")){
        grants.push(JSON.parse(String(init?.body)).eventRef);
        if(dropAck){dropAck=false;throw new Error("Committed grant acknowledgement lost")}
        if(invalidAck){invalidAck=false;return Response.json({unconfirmed:true})}
      }
      return response;
    });
  },120_000);
  beforeEach(async()=>{
    dropAck=false;invalidAck=false;validCredential=true;grants.length=0;
    d=await createCreditPurchaseNativeDriver(database!);
    const definitions=new PostgresPlanDefinitionStore(d.pool),config=new PlanDefinitionConfigProvider(new LocalFileConfigProvider(),definitions);
    policy=new BillingPolicyService(d.pool,config,definitions,client,new InternalEntitlementProvider(new PostgresEntitlementStore(d.pool),config));
    await d.admin.query("INSERT INTO billing_policy_state(tenant_id,email_verified) VALUES($1,true),($2,true)",[d.tenantA,d.tenantB]);
    await policy.synchronize(d.tenant);await policy.synchronize(d.otherTenant);
    service=new CreditPurchaseService(d.repository,d.provider,{record:async()=>({id:"aud_delivery",entry_hash:"a".repeat(64)})},policy,d.webhook);
  },60_000);
  afterEach(async()=>{policy?.onModuleDestroy();service?.onModuleDestroy();await d?.close()});
  afterAll(async()=>{await app?.close();await store?.close();await admin?.close();await container?.stop()},60_000);
  async function paid(){
    const purchase=await service.create(d.tenant,d.user,d.input,randomUUID().replaceAll("-",""));
    expect(await client.account(d.tenantA)).toMatchObject({balance:"0",available:"0"});
    d.checkout={...d.checkout!,status:"paid",amountPaidMinor:purchase.quote.totalMinor,payments:[{id:"pay_PurchaseDelivery",linkId:d.checkout!.id,
      amountMinor:purchase.quote.totalMinor,status:"captured",createdAt:new Date().toISOString()}]};
    return purchase;
  }
  const published=async()=>(await d.admin.query("SELECT credits,published_at FROM billing_credit_deliveries")).rows;
  it("lost acknowledgement retains the durable payment and retries the same three credits exactly once",async()=>{
    const purchase=await paid();dropAck=true;
    expect((await service.refresh(d.tenant,d.user,purchase.id,etag(purchase))).state).toBe("delivery_pending");
    expect(await published()).toEqual([{credits:3,published_at:null}]);expect(await client.account(d.tenantA)).toMatchObject({balance:"3",available:"3"});
    await policy.synchronize(d.tenant);expect((await service.reconcile(d.tenant,purchase.id)).state).toBe("delivered");
    expect(await client.account(d.tenantA)).toMatchObject({balance:"3",available:"3"});expect(grants).toEqual(["razorpay:pay_PurchaseDelivery","razorpay:pay_PurchaseDelivery"]);
    expect((await store.withTenant(d.tenantA,tx=>tx.query("SELECT event_ref,credits FROM billing_credit_grants WHERE tenant_id=$1",[d.tenantA]))).rows)
      .toEqual([{event_ref:"razorpay:pay_PurchaseDelivery",credits:3}]);
  });
  it("malformed acknowledgement stays pending until an actual duplicate grant is acknowledged",async()=>{
    const purchase=await paid();invalidAck=true;await service.refresh(d.tenant,d.user,purchase.id,etag(purchase));
    expect(await published()).toEqual([{credits:3,published_at:null}]);expect(await client.account(d.tenantA)).toMatchObject({balance:"3"});
    await service.reconcile(d.tenant,purchase.id);expect((await service.reconcile(d.tenant,purchase.id)).state).toBe("delivered");
    expect(await client.account(d.tenantA)).toMatchObject({balance:"3"});
  });
  it("invalid service credentials grant nothing and recovering credentials delivers the original snapshot",async()=>{
    const purchase=await paid();validCredential=false;await service.refresh(d.tenant,d.user,purchase.id,etag(purchase));
    expect(await published()).toEqual([{credits:3,published_at:null}]);validCredential=true;expect(await client.account(d.tenantA)).toMatchObject({balance:"0"});
    await policy.synchronize(d.tenant);expect(await client.account(d.tenantA)).toMatchObject({balance:"3"});
    expect((await service.reconcile(d.tenant,purchase.id)).state).toBe("delivered");
  });
  it("duplicate paid reconciliation preserves other tenant balance, ordinary RLS and conflicting-quantity refusal",async()=>{
    const purchase=await paid();await Promise.all([service.paidNotification({tenantId:d.tenant,purchaseId:purchase.id},"evt_paid_a"),
      service.paidNotification({tenantId:d.tenant,purchaseId:purchase.id},"evt_paid_b")]);
    expect(await client.account(d.tenantA)).toMatchObject({balance:"3"});expect(await client.account(d.tenantB)).toMatchObject({balance:"0"});
    expect((await store.withTenant(d.otherTenant.slice(4),tx=>tx.query("SELECT * FROM billing_credit_grants WHERE tenant_id=$1",[d.tenantA]))).rows).toEqual([]);
    expect((await store.withTenant(d.tenantA,tx=>tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows)
      .toEqual([{rolsuper:false,rolbypassrls:false}]);
    await expect(client.grant(d.tenantA,"razorpay:pay_PurchaseDelivery",4)).rejects.toThrow();expect(await client.account(d.tenantA)).toMatchObject({balance:"3"});
  });
});
