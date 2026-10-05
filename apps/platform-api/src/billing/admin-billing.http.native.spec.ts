import "reflect-metadata";
import {randomUUID,generateKeyPairSync,sign} from "node:crypto";
// eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- loopback issuer exercises actual signed audit gRPC authentication.
import {createServer,type Server} from "node:http";
import {createServer as reservePort} from "node:net";
import {createRequire} from "node:module";
import {readdirSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {v7 as uuidv7} from "uuid";
import pg from "pg";
import {Test} from "@nestjs/testing";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {createMockBillingProvider} from "@alterx/shared-clients";
import {RazorpayBillingProvider,AuditServiceClient,PostgresAuditStoreProvider,startAuditGrpcTransport} from "@alterx/adapters";
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from "@testcontainers/postgresql";
import {BillingRepository} from "./billing.repository";
import {RbacModule} from "../rbac";
import {StaffService} from "../staff/staff.service";
import {StaffRepository} from "../staff/staff.repository";
import {StaffAuthMiddleware} from "../staff/staff.middleware";
import {AdminAuditService} from "../admin-audit";
import {AdminBillingController} from "./admin-billing.controller";
import {AdminBillingOperationsService} from "./admin-billing-operations.service";
import {AdminBillingOperationsRepository} from "./admin-billing-operations.repository";
import {BillingPolicyService} from "./billing-policy.service";
import {BillingPolicyClient} from "../engine/billing-policy-client";
import {PostgresPlanDefinitionStore} from "../entitlements/plan-definition-store";
import {PlanDefinitionConfigProvider} from "../entitlements/plan-definition-config-provider";
import {LocalFileConfigProvider} from "../entitlements/adapters/local-file/local-file-config-provider";
import {InternalEntitlementProvider} from "../entitlements/internal-entitlement-provider";
import {PostgresEntitlementStore} from "../entitlements/entitlement-store";
import {AdminBillingService} from "./admin-billing.service";
import {AdminBillingRepository} from "./admin-billing.repository";
const requireBuilt=createRequire(resolve("package.json"));
const {AppModule:AuditAppModule}=requireBuilt(resolve("dist/apps/audit-service/app.module.js"));
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("billing operations current staff cookie",()=>{
 let admin:pg.Client,pool:pg.Pool,app:NestFastifyApplication,schema:string,role:string,auditMode:"ok"|"fail"|"invalid"="ok",providerMode:"pending"|"active"|"unpaid"|"wrong"|"badurl"|"network"|"timeout"="pending";
 let auditApp:NestFastifyApplication,auditContainer:StartedPostgreSqlContainer,auditDb:pg.Client,jwks:Server,auditClient:AuditServiceClient;
 const events:Record<string,unknown>[]=[],providerCalls:string[]=[];
 const tenant=uuidv7(),cookie={cookie:"alter_staff_access=valid-billing-staff"},path="/api/v1/admin/billing";
 beforeAll(async()=>{
  schema="billops_"+randomUUID().replaceAll("-","_");role="billops_"+randomUUID().replaceAll("-","_");admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Billing tenant','active')",[tenant]);
  await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_billops','auth0|stf_billops','billing@example.test',ARRAY['staff_billing_ops'])");
  await admin.query("INSERT INTO billing_dunning_states(tenant_id,state,current_plan,first_failed_at) VALUES($1,'grace','basic',now())",[tenant]);
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role},platform_provisioner`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
  const url=new URL(database!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:url.href});
  const realFetch=globalThis.fetch;vi.stubEnv("AUTH0_STAFF_DOMAIN","billing.staff.test");vi.stubGlobal("fetch",async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{if(String(input)!=="https://billing.staff.test/userinfo")return realFetch(input,init);return new Headers(init?.headers).get("authorization")==="Bearer valid-billing-staff"?Response.json({sub:"auth0|stf_billops",email:"billing@example.test"}):new Response("",{status:401});});
  auditContainer=await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("audit_db").withPassword(randomUUID()).start();
  auditDb=new pg.Client({connectionString:auditContainer.getConnectionUri()});await auditDb.connect();const auditPassword=randomUUID();await auditDb.query(`CREATE ROLE audit_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${auditPassword}'`);await auditDb.query("ALTER DATABASE audit_db OWNER TO audit_service");await auditDb.query("GRANT CREATE,USAGE ON SCHEMA public TO audit_service");const auditUrl=new URL(auditContainer.getConnectionUri());auditUrl.username="audit_service";auditUrl.password=auditPassword;
  const auditStore=new PostgresAuditStoreProvider({authentication:"static",connectionString:auditUrl.href,migrationsFolder:resolve("apps/audit-service/drizzle")});await auditStore.migrate();
  const key=generateKeyPairSync("rsa",{modulusLength:2048}),kid="billing-native";jwks=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({keys:[{...key.publicKey.export({format:"jwk"}),kid,alg:"RS256",use:"sig"}]}));});await new Promise<void>(done=>jwks.listen(0,"127.0.0.1",done));const address=jwks.address();if(!address||typeof address==="string")throw new Error("JWKS unavailable");
  for(const [name,value] of Object.entries({AUTH0_DOMAIN:"billing.audit.test",API_AUDIENCE:"alter-engine",AUTH0_JWKS_URL:`http://127.0.0.1:${address.port}`}))vi.stubEnv(name,value);
  const auditModule=await Test.createTestingModule({imports:[AuditAppModule.register(auditStore)]}).compile();auditApp=auditModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());const reservation=reservePort();await new Promise<void>(done=>reservation.listen(0,"127.0.0.1",done));const reserved=reservation.address();if(!reserved||typeof reserved==="string")throw new Error("Audit address unavailable");await new Promise<void>(done=>reservation.close(()=>done()));const auditAddress=`127.0.0.1:${reserved.port}`;
  await startAuditGrpcTransport(auditApp,{bindAddress:auditAddress,protoPath:resolve("packages/contracts/proto/alter/audit/v1/audit.proto")});await auditApp.listen(0,"127.0.0.1");
  const token=()=>{const now=Math.floor(Date.now()/1000),value=[{alg:"RS256",kid},{iss:"https://billing.audit.test/",aud:"alter-engine",iat:now,exp:now+60,tenant_id:`ten_${tenant}`,"https://alter.dev/claims/actor_type":"service"}].map(value=>Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");return `${value}.${sign("RSA-SHA256",Buffer.from(value),key.privateKey).toString("base64url")}`;};
  auditClient=new AuditServiceClient({address:auditAddress,protoPath:resolve("packages/contracts/proto/alter/audit/v1/audit.proto"),accessTokenProvider:{getAccessToken:async()=>auditMode==="fail"?"invalid-audit-credential":token()}});
  const audit=new AdminAuditService({record:async(input:Parameters<AuditServiceClient["recordEvent"]>[0])=>{events.push(input as unknown as Record<string,unknown>);const ack=await auditClient.recordEvent(input);return auditMode==="invalid"?{entry_hash:"invalid"}:ack;}} as never),staff=new StaffService(new StaffRepository(pool),audit),middleware=new StaffAuthMiddleware(staff);
  const definitions=new PostgresPlanDefinitionStore(pool),config=new PlanDefinitionConfigProvider(new LocalFileConfigProvider(),definitions),entitlements=new InternalEntitlementProvider(new PostgresEntitlementStore(pool),config);
  const limits=await config.getEntitlementDefaults("free"),commercial={currency:"INR" as const,basePriceMinor:10003,razorpayPlanId:"plan_Billops",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2};
  await definitions.upsert("basic",limits,"stf_billops",commercial,"Native billing plan");
  await admin.query("INSERT INTO billing_profiles(tenant_id,id,provider_id,status,current_plan,subscription_ref,provider_plan_ref,commercial_snapshot) VALUES($1,$2,'razorpay','pending','basic','sub_Billops','plan_Billops',$3::jsonb)",[tenant,uuidv7(),JSON.stringify(commercial)]);
  await entitlements.createEntitlement(tenant,"basic",undefined,{accessState:"grace"});
  await admin.query("INSERT INTO billing_policy_state(tenant_id,email_verified) VALUES($1,true)",[tenant]);
  const policy=new BillingPolicyService(pool,config,definitions,new BillingPolicyClient("https://engine.billing.test",async()=>"billing-fixture",async()=>Response.json({applied:true})),entitlements);
  const provider=new RazorpayBillingProvider({keyIdSecretRef:"test-id",keySecretSecretRef:"test-key"},{getSecret:async()=>"provider-edge-fixture"} as never,new BillingRepository(pool),{request:async request=>{
   providerCalls.push(request.path);if(providerMode==="network")throw new Error("Provider edge unavailable");if(providerMode==="timeout")return new Promise<never>(()=>{});const now=Math.floor(Date.now()/1000)+1;
   if(request.path.startsWith("/v1/invoices?"))return {status:200,body:{count:1,items:[{id:"inv_Billops",subscription_id:"sub_Billops",status:providerMode==="unpaid"?"issued":"paid",amount:11804,currency:"INR",created_at:now,issued_at:now,paid_at:providerMode==="unpaid"?null:now,short_url:"https://rzp.io/rzp/nativeinvoice"}]}};
   return {status:200,body:{id:providerMode==="wrong"?"sub_Other":"sub_Billops",plan_id:"plan_Billops",status:["active","unpaid"].includes(providerMode)?"active":"pending",short_url:providerMode==="badurl"?"https://outside.test/path":"https://rzp.io/rzp/native-recovery"}};
  }});
  const operations=new AdminBillingOperationsService(new AdminBillingOperationsRepository(pool),provider,audit,policy,entitlements,definitions);
  const service=new AdminBillingService(createMockBillingProvider(),audit,new AdminBillingRepository(pool));
  const module=await Test.createTestingModule({imports:[RbacModule],controllers:[AdminBillingController],providers:[{provide:AdminBillingService,useValue:service},{provide:AdminBillingOperationsService,useValue:operations}]}).compile();app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());app.getHttpAdapter().getInstance().addHook("preHandler",async(request,reply)=>middleware.use(request as unknown as Parameters<StaffAuthMiddleware["use"]>[0],reply,()=>{}));await app.init();await app.getHttpAdapter().getInstance().ready();
 },120000);
 afterAll(async()=>{await app?.close();await auditApp?.close();await auditDb?.end();if(jwks)await new Promise<void>(done=>jwks.close(()=>done()));await auditContainer?.stop();await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}vi.unstubAllGlobals();vi.unstubAllEnvs();},60000);
 it("accepts a reasoned run-credit grant through the actual staff route",async()=>{
  const response=await app.inject({method:"POST",url:`${path}/issues/${tenant}/actions/grant-credits`,headers:{...cookie,"if-match":`"billing-${tenant}-1"`},payload:{runs:3,reason:"Restore three verified runs after a recorded support adjustment"}});
  expect(response.statusCode).toBe(201);
 });
 const queue=()=>app.inject({method:"GET",url:path+"/issues",headers:cookie});
 const revision=async()=>((await queue()).json() as Array<{tenant_id:string;etag:string}>).find(item=>item.tenant_id===tenant)!.etag;
 const apply=async(action:string,etag:string|undefined,body:unknown={reason:"Investigate actual provider evidence"},headers:Record<string,string>=cookie)=>app.inject({method:"POST",url:`${path}/issues/${tenant}/actions/${action}`,headers:{...headers,"content-type":"application/json",...(etag?{"if-match":etag}:{})},payload:JSON.stringify(body)});
 it("rejects missing, stale and wildcard revisions and forged attribution",async()=>{
  for(const [etag,status] of [[undefined,428],["\"stale\"",412],["*",412]] as const)expect((await apply("grant-credits",etag,{runs:1,reason:"Investigated"})).statusCode).toBe(status);
  for(const body of [{runs:1,reason:""},{runs:0,reason:"Valid"},{runs:1,reason:"Valid",actor_ref:"stf_forged"},{runs:1,reason:"x".repeat(1001)}])expect((await apply("grant-credits",await revision(),body)).statusCode).toBe(400);
 });
 it("requires actual current staff roles and active staff cookies",async()=>{
  for(const headers of [{},{cookie:"alter_staff_access=expired"}])expect((await apply("grant-credits",undefined,{runs:1,reason:"Investigated"},headers)).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_support'] WHERE id='stf_billops'");expect((await queue()).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_billing_ops'],deactivated_at=now() WHERE id='stf_billops'");expect((await queue()).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET deactivated_at=NULL WHERE id='stf_billops'");
 });
 it("retains the full Unicode reason and rolls back history, revision and grant on missing audit acknowledgement",async()=>{
  const reason="調".repeat(1000),etag=await revision();const accepted=await apply("grant-credits",etag,{runs:5,reason});expect(accepted.statusCode).toBe(201);expect(accepted.json()).toMatchObject({runs:5,credits:10,reason,actor_ref:"stf_billops",delivery:"delivered"});
  const history=await app.inject({method:"GET",url:`${path}/issues/${tenant}/history`,headers:cookie});expect(history.json()).toContainEqual(expect.objectContaining({id:accepted.json().id,reason}));
  for(const mode of ["fail","invalid"] as const){const before=await revision();auditMode=mode;expect((await apply("grant-credits",before,{runs:1,reason:"Audit must acknowledge"})).statusCode).toBe(500);auditMode="ok";expect(await revision()).toBe(before);}
  expect(events).toContainEqual(expect.objectContaining({tenant_id:tenant,actor_ref:"stf_billops",action:"billing.issue.grant_credits",reason_code:"staff_billing_decision"}));
 });
 it("serializes simultaneous grants and does not silently grant twice",async()=>{
  const etag=await revision();const responses=await Promise.all([apply("grant-credits",etag,{runs:1,reason:"First contender"}),apply("grant-credits",etag,{runs:1,reason:"Second contender"})]);expect(responses.map(response=>response.statusCode).sort()).toEqual([201,412]);
 });
 it("returns actual provider recovery link while leaving unpaid access unchanged",async()=>{
  providerMode="pending";const response=await apply("retry",await revision());expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({action:"retry",recovery_url:"https://rzp.io/rzp/native-recovery",delivery:null});
  expect((await queue()).json()).toContainEqual(expect.objectContaining({tenant_id:tenant,state:"grace"}));expect(providerCalls).toContain("/v1/subscriptions/sub_Billops");
  for(const mode of ["wrong","badurl"] as const){providerMode=mode;expect((await apply("retry",await revision())).statusCode).toBe(502);}providerMode="pending";
 });
 it("rejects provider network failures and deadlines without committing a revision",async()=>{
  for(const [mode,status] of [["network",502],["timeout",504]] as const){const before=await revision();providerMode=mode;const response=await apply("retry",before);providerMode="pending";expect(response.statusCode).toBe(status);expect(await revision()).toBe(before);}
 },10000);
 it("rejects missing or deleted subjects and reports history audit unavailability",async()=>{
  expect((await app.inject({method:"POST",url:`${path}/issues/${uuidv7()}/actions/grant-credits`,headers:{...cookie,"if-match":"current"},payload:{runs:1,reason:"Named missing subject"}})).statusCode).toBe(404);
  const before=await revision();await admin.query("UPDATE tenants SET status='deleted',deleted_at=now() WHERE id=$1",[tenant]);expect((await apply("grant-credits",before,{runs:1,reason:"Deleted subject"})).statusCode).toBe(404);await admin.query("UPDATE tenants SET status='active',deleted_at=NULL WHERE id=$1",[tenant]);
  auditMode="fail";const response=await app.inject({method:"GET",url:`${path}/issues/${tenant}/history`,headers:cookie});auditMode="ok";expect(response.statusCode).toBe(500);
 });
 it("refuses pending subscription mutations and missing paid plan configuration",async()=>{
  const before=await revision();await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);await admin.query("UPDATE billing_profiles SET mutation_attempt_id=$2 WHERE tenant_id=$1",[tenant,uuidv7()]);expect((await apply("grant-credits",before,{runs:1,reason:"Pending subscription"})).statusCode).toBe(409);await admin.query("UPDATE billing_profiles SET mutation_attempt_id=NULL WHERE tenant_id=$1",[tenant]);
  await admin.query("UPDATE billing_dunning_states SET current_plan='free' WHERE tenant_id=$1",[tenant]);expect((await apply("grant-credits",await revision(),{runs:1,reason:"No paid plan"})).statusCode).toBe(409);await admin.query("UPDATE billing_dunning_states SET current_plan='basic' WHERE tenant_id=$1",[tenant]);
  const rows=await auditDb.query("SELECT actor_ref,tenant_id::text,action FROM audit_events WHERE action='billing.issue.grant_credits'");expect(rows.rows).toContainEqual({actor_ref:"stf_billops",tenant_id:tenant,action:"billing.issue.grant_credits"});
 });
 it("refuses unpaid recovery and resolves only current provider-bound paid evidence",async()=>{
  providerMode="unpaid";const before=await revision();expect((await apply("resolve",before)).statusCode).toBe(409);expect(await revision()).toBe(before);
  providerMode="active";const response=await apply("resolve",before);expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({action:"resolve",invoice_ref:"inv_Billops",subscription_ref:"sub_Billops"});
  expect((await queue()).json().some((item:{tenant_id:string})=>item.tenant_id===tenant)).toBe(false);
  await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);expect((await admin.query("SELECT state FROM billing_dunning_states WHERE tenant_id=$1",[tenant])).rows[0].state).toBe("active");
  expect((await admin.query("SELECT access_state FROM entitlements WHERE tenant_id=$1 AND effective_to IS NULL",[tenant])).rows[0].access_state).toBe("active");
 });

});
