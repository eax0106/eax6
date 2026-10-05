import {createSign,generateKeyPairSync,randomBytes,randomUUID} from "node:crypto";
// eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- loopback JWKS issuer for signed native authentication proofs.
import {createServer,type Server} from "node:http";
import {createRequire} from "node:module";
import {readFileSync,readdirSync} from "node:fs";
import {resolve} from "node:path";
import pg from "pg";
import {v7 as uuidv7} from "uuid";
import {Test} from "@nestjs/testing";
import {APP_GUARD,APP_FILTER} from "@nestjs/core";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {PostgresOrchestrationStoreProvider,PostgresCostStoreProvider} from "@alterx/adapters";
import type {CanActivate} from "@nestjs/common";
import {M2mValidator,ServiceAuthGuard} from "@alterx/auth";
import {RedisContainer,type StartedRedisContainer} from "@testcontainers/redis";
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from "@testcontainers/postgresql";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {RbacModule} from "../rbac";
import {StaffService} from "../staff/staff.service";
import {StaffRepository} from "../staff/staff.repository";
import {StaffAuthMiddleware} from "../staff/staff.middleware";
import {AdminAuditService} from "../admin-audit";
import {AdminTenantsController} from "./admin-tenants.controller";
import {AdminTenantsService} from "./admin-tenants.service";
import {AdminTenantsRepository} from "./admin-tenants.repository";
import {AdminTenantActivityService} from "./admin-tenant-activity.service";
import {TenantActivityClient} from "../engine/tenant-activity-client";
import {engineConfigFromEnvironment} from "../engine/config";
import {EngineExceptionFilter} from "../engine/engine-exception.filter";
import {ENTITLEMENT_PROVIDER} from "../entitlements/entitlement-provider.interface";
// Exercise built sibling services across TCP rather than importing another app's source.
const requireBuilt=createRequire(resolve("package.json"));
const {SecurityModule}=requireBuilt(resolve("dist/apps/orchestration-service/security.module.js"));
const {orchestrationStore,identityTenantGatewayEnvironment}=requireBuilt(resolve("dist/apps/orchestration-service/orchestration-infrastructure.module.js"));
const {TenantActivityController}=requireBuilt(resolve("dist/apps/orchestration-service/tenant-activity/tenant-activity.controller.js"));
const {TenantActivityService}=requireBuilt(resolve("dist/apps/orchestration-service/tenant-activity/tenant-activity.service.js"));
const {RUN_LEARNING_AUDIT}=requireBuilt(resolve("dist/apps/orchestration-service/runs/run-learning.controller.js"));
const {TenantSpendController}=requireBuilt(resolve("dist/apps/cost-ledger-service/rollup/tenant-spend.controller.js"));
const {TenantSpendService}=requireBuilt(resolve("dist/apps/cost-ledger-service/rollup/tenant-spend.service.js"));
const {applyMargin}=requireBuilt(resolve("dist/apps/cost-ledger-service/rollup/cost-rollup.service.js"));
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("tenant activity current staff cookie and authenticated native service HTTP",()=>{
 let admin:pg.Client,pool:pg.Pool,schema:string,role:string,app:NestFastifyApplication,engine:NestFastifyApplication,cost:NestFastifyApplication,jwks:Server;
 let redis:StartedRedisContainer,guardStore:PostgresOrchestrationStoreProvider;
 let engineContainer:StartedPostgreSqlContainer,costContainer:StartedPostgreSqlContainer,engineAdmin:PostgresOrchestrationStoreProvider,engineStore:PostgresOrchestrationStoreProvider,costAdmin:PostgresCostStoreProvider,costStore:PostgresCostStoreProvider;
 let engineBase:string,costBase:string,jwksBase:string,auditUnavailable=false,engineAuditUnavailable=false,badMachine=false;
 const tenant=uuidv7(),other=uuidv7(),member=uuidv7(),workspace=uuidv7(),grant="jit_"+uuidv7(),workflow=`wf_${uuidv7()}`,run=`run_${uuidv7()}`;
 const end="2026-10-05T00:00:00.000Z",start="2026-09-05T00:00:00.000Z",window={tenant_id:tenant,start_at:start,end_at:end};
 const events:Record<string,unknown>[]=[],engineEvents:Record<string,unknown>[]=[];
 const key=generateKeyPairSync("rsa",{modulusLength:2048}),kid="native-activity-key";
 const sign=(claims:Record<string,unknown>)=>{const data=[{alg:"RS256",typ:"JWT",kid},claims].map(value=>Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");return data+"."+createSign("RSA-SHA256").update(data).sign(key.privateKey).toString("base64url");};
 const machine=()=>{const now=Math.floor(Date.now()/1000);return sign({iss:"https://activity.auth.test/",aud:"alter-engine",iat:now,exp:now+300,tenant_id:"platform-api","https://alter.dev/claims/actor_type":"service"});};
 beforeAll(async()=>{
  schema="detail_"+randomUUID().replaceAll("-","_");role="detail_"+randomUUID().replaceAll("-","_");
  admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Activity tenant','active'),($2,'Other tenant','active')",[tenant,other]);
  await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,'auth0|activity-member','member@activity.test','active')",[member]);
  await admin.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'member')",[uuidv7(),tenant,member]);
  for(const [id,identity,roles] of [["stf_activity","auth0|activity",["staff_support"]],["stf_other","auth0|other",["staff_support"]]])await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES($1,$2,$3,$4)",[id,identity,`${id}@staff.test`,roles]);
  await admin.query("INSERT INTO jit_grants(id,staff_user_id,tenant_id,reason_code,reason_text,expires_at,scopes) VALUES($1,'stf_activity',$2,'support_investigation','Actual activity review',now()+interval '1 hour',ARRAY['tenant:read'])",[grant,tenant]);
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const url=new URL(database!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:url.href});
  engineContainer=await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();costContainer=await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();
  engineAdmin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:engineContainer.getConnectionUri(),migrationsFolder:resolve("apps/orchestration-service/drizzle")});await engineAdmin.migrate();
  costAdmin=new PostgresCostStoreProvider({authentication:"static",connectionString:costContainer.getConnectionUri(),migrationsFolder:resolve("apps/cost-ledger-service/drizzle")});await costAdmin.migrate();
  for(const store of [engineAdmin,costAdmin])await store.withTenant(tenant,async tx=>{await tx.query(`CREATE ROLE detail_reader LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await tx.query("GRANT USAGE ON SCHEMA public TO detail_reader");await tx.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO detail_reader");});
  const ordinary=(value:string)=>{const uri=new URL(value);uri.username="detail_reader";uri.password=password;return uri.href;};
  engineStore=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:ordinary(engineContainer.getConnectionUri()),migrationsFolder:resolve("apps/orchestration-service/drizzle")});
  costStore=new PostgresCostStoreProvider({authentication:"static",connectionString:ordinary(costContainer.getConnectionUri()),migrationsFolder:resolve("apps/cost-ledger-service/drizzle")});
  await engineStore.withTenant(tenant,async tx=>{await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Actual HTTP workflow')",[workflow,tenant,workspace]);await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,workflow_id,parent_kind,status,created_at) VALUES($1,$2,$3,$4,'workflow','completed',$5)",[run,tenant,workspace,workflow,start]);});
  await costStore.withTenant(tenant,tx=>tx.query("INSERT INTO cost_events(id,tenant_id,workspace_id,mode,source,provider,resource,quantity,unit,internal_cost_minor,currency,occurred_at) VALUES($1,$2,$3,'workflow','tool_gateway','fixture','call',1,'call',101,'INR',$4)",[uuidv7(),tenant,workspace,start]));
  jwks=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({keys:[{...key.publicKey.export({format:"jwk"}),alg:"RS256",use:"sig",kid}]}));});await new Promise<void>(resolve=>jwks.listen(0,"127.0.0.1",resolve));const address=jwks.address();if(!address||typeof address==="string")throw new Error("Invalid fixture address");jwksBase=`http://127.0.0.1:${address.port}`;
  const validator=()=>new M2mValidator({auth0Domain:"activity.auth.test",apiAudience:"alter-engine",jwksUrl:jwksBase});
  redis=await new RedisContainer("redis:7-alpine").start();
  const guards=(Reflect.getMetadata("providers",SecurityModule) as {provide:unknown;useFactory?:()=>CanActivate}[]).filter(provider=>provider.provide===APP_GUARD);
  expect(guards).toHaveLength(3);
  let guard:CanActivate;
  try{
   for(const [name,value] of Object.entries({ALTER_ENV:"local",AUTH0_DOMAIN:"activity.auth.test",AUTH0_API_AUDIENCE:"alter-engine",AUTH0_JWKS_URL:jwksBase,
    ACTOR_TOKEN_ISSUER:"activity-actor",ACTOR_TOKEN_AUDIENCE:"alter-engine",ACTOR_TOKEN_JWKS_URL:jwksBase,REDIS_ENDPOINT:redis.getConnectionUrl(),
    ORCHESTRATION_DATABASE_AUTHENTICATION:"static",ORCHESTRATION_DATABASE_URL:ordinary(engineContainer.getConnectionUri()),AWS_REGION:"ap-south-1",ALTER_ARTIFACTS_BUCKET_PARAM:"/alter/local/orchestration/artifacts-bucket"}))vi.stubEnv(name,value);
   const factory=guards[0]?.useFactory;if(!factory)throw new Error("Production authentication factory missing");guard=factory();
   guardStore=orchestrationStore(identityTenantGatewayEnvironment(process.env));
  }finally{vi.unstubAllEnvs();}
  const engineModule=await Test.createTestingModule({controllers:[TenantActivityController],providers:[{provide:TenantActivityService,useValue:new TenantActivityService(engineStore)},{provide:RUN_LEARNING_AUDIT,useValue:{recordEvent:async(input:Record<string,unknown>)=>{if(engineAuditUnavailable)throw new Error("Audit unavailable");engineEvents.push(input);return {entry_hash:"a".repeat(64)};}}},{provide:APP_GUARD,useValue:guard}]}).compile();
  engine=engineModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await engine.listen(0,"127.0.0.1");engineBase=await engine.getUrl();
  const costModule=await Test.createTestingModule({controllers:[TenantSpendController],providers:[{provide:TenantSpendService,useValue:new TenantSpendService(costStore,(minor:string)=>applyMargin(minor,0.2))},{provide:APP_GUARD,useValue:new ServiceAuthGuard(validator())}]}).compile();
  cost=costModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await cost.listen(0,"127.0.0.1");costBase=await cost.getUrl();
  const realFetch=globalThis.fetch;vi.stubEnv("AUTH0_STAFF_DOMAIN","activity.staff.test");vi.stubGlobal("fetch",async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{if(String(input)!=="https://activity.staff.test/userinfo")return realFetch(input,init);const token=new Headers(init?.headers).get("authorization");return token==="Bearer actual-staff"?Response.json({sub:"auth0|activity",email:"staff@test.test"}):token==="Bearer other-staff"?Response.json({sub:"auth0|other",email:"other@test.test"}):new Response("",{status:401});});
  const audit=new AdminAuditService({record:async(input:Record<string,unknown>)=>{if(auditUnavailable)throw new Error("Audit unavailable");events.push(input);return {entry_hash:"a".repeat(64)};}} as never);
  const staff=new StaffService(new StaffRepository(pool),audit),middleware=new StaffAuthMiddleware(staff),repository=new AdminTenantsRepository(pool);
  const config=engineConfigFromEnvironment({ENGINE_BASE_URL:engineBase,ADS_CORE_BASE_URL:engineBase,COST_LEDGER_BASE_URL:costBase,EVAL_FACADE_TOKEN_REF:"unused",DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF:"unused",AUDIT_SERVICE_BASE_URL:engineBase,AUDIT_QUERY_SERVICE_TOKEN_REF:"unused",ENGINE_M2M_TOKEN_URL:jwksBase,ENGINE_M2M_AUDIENCE:"alter-engine",ENGINE_M2M_CLIENT_ID:"platform",ENGINE_M2M_CLIENT_SECRET_REF:"unused"});
  const client=new TenantActivityClient(config,{getAccessToken:async()=>badMachine?"invalid-machine-token":machine()});
  const module=await Test.createTestingModule({imports:[RbacModule],controllers:[AdminTenantsController],providers:[AdminTenantsService,{provide:AdminTenantsRepository,useValue:repository},{provide:AdminTenantActivityService,useValue:new AdminTenantActivityService(repository,client,audit,()=>new Date(end))},{provide:AdminAuditService,useValue:audit},{provide:StaffService,useValue:staff},{provide:ENTITLEMENT_PROVIDER,useValue:{}},{provide:APP_FILTER,useClass:EngineExceptionFilter}]}).compile();
  app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());app.getHttpAdapter().getInstance().addHook("preHandler",async(request,reply)=>middleware.use(request as unknown as Parameters<StaffAuthMiddleware["use"]>[0],reply,()=>{}));await app.init();await app.getHttpAdapter().getInstance().ready();
 },120000);
 beforeEach(async()=>{events.length=0;engineEvents.length=0;auditUnavailable=false;engineAuditUnavailable=false;badMachine=false;await admin.query("UPDATE staff_users SET roles=ARRAY['staff_support'],deactivated_at=NULL WHERE id='stf_activity'");await admin.query("UPDATE jit_grants SET granted_at=now(),expires_at=now()+interval '1 hour',revoked_at=NULL,scopes=ARRAY['tenant:read'] WHERE id=$1",[grant]);});
 afterAll(async()=>{await app?.close();await engine?.close();await cost?.close();if(jwks)await new Promise<void>((resolve,reject)=>jwks.close(error=>error?reject(error):resolve()));await pool?.end();await engineStore?.close();await costStore?.close();await engineAdmin?.close();await costAdmin?.close();await guardStore?.close();await redis?.stop();await engineContainer?.stop();await costContainer?.stop();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}vi.unstubAllGlobals();vi.unstubAllEnvs();},60000);
 const headers={cookie:"alter_staff_access=actual-staff","x-alter-support-grant":grant};
 const read=(id=tenant,auth:Record<string,string>=headers)=>app.inject({method:"GET",url:`/api/v1/admin/tenants/${id}/activity`,headers:auth});
 it("serves actual records over both authenticated TCP services and records the real staff actor",async()=>{
  for(const store of [engineStore,costStore])expect((await store.withTenant(tenant,tx=>tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
  expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
  const result=await read();expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({...window,workflow_count:1,run_count:1,members:{count:1,members:[{email:"member@activity.test"}]},workflows:[{id:workflow,name:"Actual HTTP workflow"}],runs:[{id:run}],spend:{currencies:[{currency:"INR",billed_minor:"127",event_count:1}]}});
  expect(events).toContainEqual(expect.objectContaining({actor_type:"admin",actor_ref:"stf_activity",tenant_id:tenant,action:"tenant.activity.read"}));expect(engineEvents).toContainEqual(expect.objectContaining({actor_type:"service",actor_ref:"service:platform-api",tenant_id:tenant,action:"tenant.activity.read"}));
  expect(JSON.stringify(result.json())).not.toMatch(/internal_cost|margin_minor/);
 });
 it("requires current staff roles and a matching, active, scoped grant",async()=>{
  for(const auth of [{},{cookie:"alter_staff_access=expired"},{cookie:headers.cookie},{...headers,cookie:"alter_staff_access=other-staff"}])expect((await read(tenant,auth)).statusCode).toBe(403);
  expect((await read(other)).statusCode).toBe(403);expect(engineEvents).toHaveLength(0);
  for(const update of ["expires_at=now()-interval '1 second',granted_at=now()-interval '2 hours'","revoked_at=now()","scopes=ARRAY['audit:read']"]){await admin.query(`UPDATE jit_grants SET ${update} WHERE id=$1`,[grant]);expect((await read()).statusCode).toBe(403);await admin.query("UPDATE jit_grants SET granted_at=now(),expires_at=now()+interval '1 hour',revoked_at=NULL,scopes=ARRAY['tenant:read'] WHERE id=$1",[grant]);}
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_admin','staff_security'] WHERE id='stf_activity'");expect((await read(tenant,{cookie:headers.cookie})).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_security'] WHERE id='stf_activity'");expect((await read(tenant,{cookie:headers.cookie})).statusCode).toBe(200);
  await admin.query("UPDATE staff_users SET deactivated_at=now() WHERE id='stf_activity'");expect((await read()).statusCode).toBe(403);
 });
 it("keeps unknown subjects, service transport and mandatory audit failures explicit",async()=>{
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_billing_ops'] WHERE id='stf_activity'");
  expect((await read(uuidv7(),{cookie:headers.cookie})).statusCode).toBe(404);expect((await read("invalid",{cookie:headers.cookie})).statusCode).toBe(400);
  badMachine=true;const unavailable=await read();expect(unavailable.statusCode).toBe(502);expect(unavailable.json().error_code).toBe("UPSTREAM_SERVICE_ERROR");badMachine=false;
  engineAuditUnavailable=true;expect((await read()).statusCode).toBe(502);engineAuditUnavailable=false;
  auditUnavailable=true;expect((await read()).statusCode).toBe(500);auditUnavailable=false;
  expect((await read()).statusCode).toBe(200);
 });
 it("authenticates service reads, validates the window and refuses delegated user and system assertions",async()=>{
  for(const base of [engineBase,costBase]){
   const path=base===engineBase?"/internal/tenant-activity":"/internal/tenant-spend";
   // eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- loopback native service authentication proof.
   const request=(query:Record<string,string>=window,auth:Record<string,string>={})=>fetch(base+path+"?"+new URLSearchParams(query),{headers:auth});
   expect((await request()).status).toBe(401);expect((await request(window,{authorization:"Bearer invalid"})).status).toBe(401);
   expect((await request({...window,start_at:end},{authorization:"Bearer "+machine()})).status).toBe(400);
   expect((await request({...window,staff_user_id:"stf_forged"},{authorization:"Bearer "+machine()})).status).toBe(400);
   expect((await request(window,{authorization:"Bearer "+machine()})).status).toBe(200);
   if(base===engineBase){
    const now=Math.floor(Date.now()/1000),common={iss:"activity-actor",aud:"alter-engine",iat:now,exp:now+240,auth_time:now-10,tenant_id:`ten_${tenant}`,jti:uuidv7()};
    const user=sign({...common,user_id:`usr_${member}`,workspace_id:`ws_${workspace}`,roles:["owner"],permissions:["workflows:read"],session_id:"actual-session"});
    const system=sign({...common,jti:uuidv7(),principal_type:"system",principal:"system:platform-jobs",permissions:["runs:read"]});
    for(const token of [user,system])expect((await request(window,{authorization:"Bearer "+machine(),"x-alter-actor-token":token})).status).toBe(403);
   }
  }
 });
});
