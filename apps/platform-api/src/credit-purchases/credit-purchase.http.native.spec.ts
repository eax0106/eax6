import "reflect-metadata";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgresAuditStoreProvider, RazorpayBillingProvider } from "@alterx/adapters";
import { AUDIT_STORE_PROVIDER, createMockSecretsProvider } from "@alterx/shared-clients";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RbacModule } from "../rbac";
import { PlatformDb } from "../signup/platform-db";
import { IdentityService } from "../identity/identity.service";
import type { IdentityProvider } from "../identity/identity-provider.interface";
import { PgSessionStore } from "../identity/session-store";
import { AuditEventsClient } from "../engine/audit-events-client";
import { engineConfigFromEnvironment } from "../engine/config";
import { BillingController } from "../billing/billing.controller";
import { BillingService } from "../billing/billing.service";
import { BillingRepository } from "../billing/billing.repository";
import { BillingEtagResolver } from "../billing/billing-etag.resolver";
import { ETAG_RESOURCE_RESOLVER } from "../concurrency";
import { BillingWebhookService } from "../billing/billing-webhook.service";
import { PgIdempotencyStore } from "../idempotency";
import type { BillingPolicyService } from "../billing/billing-policy.service";
import type { ConfigProvider, EntitlementProvider } from "../entitlements";
import { CreditPurchaseController } from "./credit-purchase.controller";
import { CreditPurchaseService } from "./credit-purchase.service";
import { createCreditPurchaseNativeDriver, type CreditPurchaseNativeDriver } from "./testing/credit-purchase-native-driver";

const requireBuilt=createRequire(resolve("package.json"));
const {AuditService}=requireBuilt(resolve("dist/apps/audit-service/audit/audit.service.js"));
const {AuditQueryController,AUDIT_QUERY_SERVICE_TOKEN_HASH}=requireBuilt(resolve("dist/apps/audit-service/audit/audit-query.controller.js"));
const database=process.env.DATABASE_URL, path="/api/v1/billing/credit-purchases";
const internalToken=randomUUID(), webhookSecret=randomUUID();
describe.skipIf(!database)("credit purchase real tenant cookie and central audit HTTP",()=>{
  let auditContainer:StartedPostgreSqlContainer,auditDb:pg.Client,auditStore:PostgresAuditStoreProvider,auditApp:NestFastifyApplication;
  let app:NestFastifyApplication,d:CreditPurchaseNativeDriver,identity:IdentityService,sessions:PgSessionStore,service:CreditPurchaseService;
  let cookie:string,otherCookie:string,sessionId:string,auditMode:"ok"|"denied"|"invalid"="ok";
  beforeAll(async()=>{
    auditContainer=await new PostgreSqlContainer("postgres:16-alpine").withDatabase("purchase_audit").withStartupTimeout(120_000).start();
    auditDb=new pg.Client({connectionString:auditContainer.getConnectionUri()});await auditDb.connect();
    const password=randomUUID();await auditDb.query(`CREATE ROLE audit_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await auditDb.query("ALTER DATABASE purchase_audit OWNER TO audit_service; GRANT CREATE,USAGE ON SCHEMA public TO audit_service");
    const url=new URL(auditContainer.getConnectionUri());url.username="audit_service";url.password=password;
    auditStore=new PostgresAuditStoreProvider({authentication:"static",connectionString:url.href,migrationsFolder:resolve("apps/audit-service/drizzle")});
    await auditStore.migrate();
    const module=await Test.createTestingModule({controllers:[AuditQueryController],providers:[AuditService,
      {provide:AUDIT_STORE_PROVIDER,useValue:auditStore},{provide:AUDIT_QUERY_SERVICE_TOKEN_HASH,useValue:createHash("sha256").update(internalToken).digest("hex")}]}).compile();
    auditApp=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await auditApp.listen(0,"127.0.0.1");
  },120_000);
  beforeEach(async()=>{
    d=await createCreditPurchaseNativeDriver(database!);auditMode="ok";
    sessions=new PgSessionStore(d.pool);identity=new IdentityService({} as IdentityProvider,sessions);
    const a=await identity.issueSignupSession(d.userA,d.tenantA),b=await identity.issueSignupSession(d.userB,d.tenantB);
    cookie=`alter_access=${a.accessToken}`;otherCookie=`alter_access=${b.accessToken}`;sessionId=a.sessionId;
    const config=engineConfigFromEnvironment({ENGINE_BASE_URL:"http://engine.test",ADS_CORE_BASE_URL:"http://ads.test",COST_LEDGER_BASE_URL:"http://cost.test",
      EVAL_FACADE_TOKEN_REF:"fixture",DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF:"fixture",AUDIT_SERVICE_BASE_URL:await auditApp.getUrl(),AUDIT_QUERY_SERVICE_TOKEN_REF:"fixture-audit",
      ENGINE_M2M_TOKEN_URL:"http://identity.test/token",ENGINE_M2M_AUDIENCE:"engine",ENGINE_M2M_CLIENT_ID:"platform-api",ENGINE_M2M_CLIENT_SECRET_REF:"fixture"});
    const secrets=createMockSecretsProvider({secrets:{"fixture-audit":internalToken}});
    const audit=new AuditEventsClient(config,{...secrets,getSecret:async()=>auditMode==="denied"?"invalid-fixture-token":internalToken},async(input,init)=>{
      // eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- exercise the actual loopback audit HTTP response and malformed acknowledgement edge.
      const response=await fetch(input,init);
      return auditMode==="invalid" && response.ok?Response.json({id:"aud_invalid",entry_hash:"bad"}):response;
    });
    service=new CreditPurchaseService(d.repository,d.provider,audit,{synchronize:async()=>{}},d.webhook);
    const provider=new RazorpayBillingProvider({keyIdSecretRef:"fixture",keySecretSecretRef:"fixture"},secrets,new BillingRepository(d.pool));
    const webhook=new BillingWebhookService(provider,{...secrets,getSecret:async()=>webhookSecret},"fixture",new PgIdempotencyStore(d.pool,3_600_000),d.webhook,
      {} as EntitlementProvider,{} as ConfigProvider,{} as BillingPolicyService,service);
    const module=await Test.createTestingModule({imports:[RbacModule],controllers:[CreditPurchaseController,BillingController],providers:[
      {provide:CreditPurchaseService,useValue:service},{provide:BillingService,useValue:{}},{provide:BillingWebhookService,useValue:webhook},
      BillingEtagResolver,{provide:ETAG_RESOURCE_RESOLVER,useExisting:BillingEtagResolver},
      {provide:PgIdempotencyStore,useValue:new PgIdempotencyStore(d.pool,3_600_000)},
    ]}).overrideProvider(IdentityService).useValue(identity).overrideProvider(PlatformDb).useValue(new PlatformDb(d.pool)).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(),{rawBody:true});await app.init();await app.getHttpAdapter().getInstance().ready();service.onModuleDestroy();
  },60_000);
  afterEach(async()=>{await app?.close();await d?.close()});
  afterAll(async()=>{await auditApp?.close();await auditStore?.close();await auditDb?.end();await auditContainer?.stop()},60_000);
  const create=(body:unknown=d.input,key=randomUUID().replaceAll("-",""),session=cookie)=>app.inject({method:"POST",url:path,headers:{cookie:session,"idempotency-key":key,"content-type":"application/json"},payload:JSON.stringify(body)});
  const get=(id:string,session=cookie)=>app.inject({method:"GET",url:`${path}/${id}`,headers:{cookie:session}});
  const refresh=(id:string,tag:string|undefined,body:unknown={},session=cookie)=>app.inject({method:"POST",url:`${path}/${id}/refresh`,headers:{cookie:session,"content-type":"application/json",...(tag?{"if-match":tag}:{})},payload:JSON.stringify(body)});
  const deliveries=async()=>(await d.admin.query("SELECT * FROM billing_credit_deliveries")).rows;

  it("creates through current cookie membership, snapshots price and records actual attributed central audit",async()=>{
    const key=randomUUID().replaceAll("-","");const first=await create(d.input,key);expect(first.statusCode).toBe(201);
    const purchase=first.json();expect(purchase).toMatchObject({state:"checkout_ready",quote:{credits:3,totalMinor:177},gstin:d.input.gstin});
    expect(first.headers.etag).toBe(`"credit-purchase-${purchase.id}-2"`);
    expect((await create(d.input,key)).json().id).toBe(purchase.id);expect(d.creates).toBe(1);
    expect((await get(purchase.id)).statusCode).toBe(200);expect((await get(purchase.id,otherCookie)).statusCode).toBe(404);
    const rows=await auditDb.query("SELECT actor_type,actor_ref,tenant_id::text,action,entry_hash FROM audit_events WHERE tenant_id=$1 ORDER BY occurred_at",[d.tenantA]);
    expect(rows.rows).toContainEqual(expect.objectContaining({actor_type:"user",actor_ref:d.user,tenant_id:d.tenantA,action:"credit_purchase.created"}));
    const local=await d.admin.query("SELECT audit_hash FROM credit_purchase_events WHERE purchase_id=$1 ORDER BY revision",[purchase.id]);
    expect(local.rows.map(row=>row.audit_hash)).toEqual(rows.rows.map(row=>(row.entry_hash as Buffer).toString("hex")));
  });
  it("refuses anonymous, forged, revoked, suspended and currently demoted buyers",async()=>{
    expect((await create(d.input,undefined,"")).statusCode).toBe(403);expect((await create(d.input,undefined,"alter_access=forged")).statusCode).toBe(403);
    await d.admin.query("UPDATE tenant_members SET role='admin' WHERE tenant_id=$1",[d.tenantA]);expect((await create()).statusCode).toBe(403);
    expect((await app.inject({method:"GET",url:path,headers:{cookie}})).statusCode).toBe(200);
    await d.admin.query("UPDATE tenant_members SET role='owner' WHERE tenant_id=$1;",[d.tenantA]);
    await d.admin.query("UPDATE users SET status='suspended' WHERE id=$1",[d.userA]);expect((await create()).statusCode).toBe(403);
    await d.admin.query("UPDATE users SET status='active' WHERE id=$1",[d.userA]);await sessions.revoke(d.tenantA,d.userA,sessionId);
    expect((await create()).statusCode).toBe(403);expect(d.creates).toBe(0);
  });
  it("rejects unknown fields, actor injection, invalid quantity, missing key and changed plan revision before provider calls",async()=>{
    for(const body of [{...d.input,amount:1},{...d.input,actor_ref:d.otherUser},{...d.input,credits:1.5},{...d.input,gstin:"bad"}])expect((await create(body)).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:path,headers:{cookie},payload:d.input})).statusCode).toBe(400);
    expect((await create({...d.input,plan_version:"2020-01-01T00:00:00.000Z"})).statusCode).toBe(412);expect(d.creates).toBe(0);
  });
  it("handles malformed named IDs as client errors and valid missing IDs as not found",async()=>{
    expect((await get("cpx_invalid")).statusCode).toBe(400);
    expect((await get("cpx_019a3258-1000-7000-8000-000000000001")).statusCode).toBe(404);
    expect((await refresh("cpx_invalid","current")).statusCode).toBe(400);
  });
  it("requires exact displayed revision and empty refresh body; concurrent refresh commits once",async()=>{
    const first=await create(),id=first.json().id,tag=String(first.headers.etag);
    expect((await refresh(id,undefined)).statusCode).toBe(428);expect((await refresh(id,'"stale"')).statusCode).toBe(412);
    expect((await refresh(id,tag,{actor_ref:d.otherUser})).statusCode).toBe(400);
    d.checkout={...d.checkout!,status:"partially_paid",amountPaidMinor:50};
    const results=await Promise.all([refresh(id,tag),refresh(id,tag)]);expect(results.map(result=>result.statusCode).sort()).toEqual([200,412]);
    expect(await deliveries()).toEqual([]);
    const row=(await auditDb.query("SELECT actor_type,actor_ref FROM audit_events WHERE tenant_id=$1 AND reason_code='payment_pending'",[d.tenantA])).rows;
    expect(row).toEqual([{actor_type:"user",actor_ref:d.user}]);
  });
  it("rolls back local creation when actual central authentication or acknowledgement fails",async()=>{
    for(const mode of ["denied","invalid"] as const){auditMode=mode;expect((await create()).statusCode).toBe(502);expect((await d.admin.query("SELECT * FROM credit_purchases")).rows).toEqual([])}
    auditMode="ok";expect(d.creates).toBe(0);expect((await create()).statusCode).toBe(201);
  });
  it("preserves uncertain provider submission and recovers same durable purchase without another POST",async()=>{
    d.failCreate=true;const key=randomUUID().replaceAll("-","");expect((await create(d.input,key)).statusCode).toBe(502);
    const pending=await create(d.input,key);expect(pending.json().state).toBe("submitting");expect(d.creates).toBe(1);
    expect((await refresh(pending.json().id,String(pending.headers.etag))).json().state).toBe("checkout_ready");expect(d.creates).toBe(1);
  });
  it("bounds hung provider writes and reads, retaining durable state and exact revision for recovery",async()=>{
    d.hangCreate=true;const key=randomUUID().replaceAll("-","");let started=Date.now();
    expect((await create(d.input,key)).statusCode).toBe(502);expect(Date.now()-started).toBeLessThan(6_500);
    d.hangCreate=false;const pending=await create(d.input,key);expect(pending.json().state).toBe("submitting");expect(d.creates).toBe(1);
    d.hangRead=true;started=Date.now();expect((await refresh(pending.json().id,String(pending.headers.etag))).statusCode).toBe(503);
    expect(Date.now()-started).toBeLessThan(6_500);expect((await get(pending.json().id)).headers.etag).toBe(pending.headers.etag);
    d.hangRead=false;expect((await refresh(pending.json().id,String(pending.headers.etag))).json().state).toBe("checkout_ready");expect(d.creates).toBe(1);
  },15_000);
  it("authenticates exact raw signed paid notification, replays once and attributes service reconciliation",async()=>{
    const first=await create(),purchase=first.json();
    await d.admin.query("INSERT INTO billing_dunning_states(tenant_id,state,current_plan) VALUES($1,'limited','basic')",[d.tenantA]);
    d.checkout={...d.checkout!,status:"paid",amountPaidMinor:purchase.quote.totalMinor,payments:[{id:"pay_HTTPNative",linkId:d.checkout!.id,
      status:"captured",amountMinor:purchase.quote.totalMinor,createdAt:new Date().toISOString()}]};
    const payload=JSON.stringify({account_id:"acc_native",event:"payment_link.paid",created_at:Math.floor(Date.now()/1000),payload:{payment_link:{entity:{
      id:d.checkout!.id,reference_id:purchase.id,notes:{tenant_id:d.tenant,alter_credit_purchase:purchase.id}}}}});
    const signature=createHmac("sha256",webhookSecret).update(payload).digest("hex");
    const send=(raw=payload,sig=signature)=>app.inject({method:"POST",url:"/api/v1/billing/webhooks/razorpay",headers:{"content-type":"application/json",
      "x-razorpay-signature":sig,"x-razorpay-event-id":"evt_credit_native"},payload:raw});
    expect((await send(payload,"bad")).statusCode).toBe(401);expect((await send(payload+" ")).statusCode).toBe(401);expect(await deliveries()).toEqual([]);
    const accepted=await send();expect(accepted.statusCode).toBe(202);expect(accepted.json()).toMatchObject({state:"limited",replayed:false});
    expect((await send()).json()).toMatchObject({replayed:true});expect(await deliveries()).toHaveLength(1);
    expect((await get(purchase.id)).json().state).toBe("delivery_pending");
    expect((await auditDb.query("SELECT actor_type,actor_ref FROM audit_events WHERE tenant_id=$1 AND reason_code='delivery_pending'",[d.tenantA])).rows)
      .toEqual([{actor_type:"service",actor_ref:"svc_billing-credit-purchases"}]);
  });
});
