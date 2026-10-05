import type {MarketplaceGovernanceItem} from "@alterx/contracts";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import pg from "pg";
import {v7 as uuidv7} from "uuid";
import {Test} from "@nestjs/testing";
import {APP_GUARD,APP_FILTER,Reflector} from "@nestjs/core";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {ActorContextGuard} from "../rbac/actor-context.guard";
import {RbacGuard} from "../rbac/rbac.guard";
import {RbacExceptionFilter} from "../rbac/rbac-exception.filter";
import {WorkspaceResourceTenantResolver,PlatformDbWorkspaceTenantLookup} from "../rbac/resource-tenant.resolver";
import {ParamWorkspaceResolver} from "../rbac/param-workspace.resolver";
import {IdentityService} from "../identity/identity.service";
import {PgSessionStore} from "../identity/session-store";
import {MockIdentityProvider} from "../identity/adapters/mock/mock-identity-provider";
import {PlatformDb} from "../signup/platform-db";
import {AuditEventsClient,EngineModule} from "../engine";
import {StaffRepository} from "../staff/staff.repository";
import {SellerGovernanceController} from "../publisher/seller-governance.controller";
import {SellerGovernanceRepository} from "../publisher/seller-governance.repository";
import {MarketplaceGovernanceModule} from "./marketplace-governance.module";
import {MarketplaceGovernanceRepository} from "./marketplace-governance.repository";
import {ToolVersionReviewRepository} from "./tool-version-review.repository";
import {applyMarketplaceMigrations} from "../db/marketplace-migrator";

const database=process.env.MARKETPLACE_DATABASE_URL;
describe.skipIf(!database)("marketplace governance current staff cookie and ordinary tenant session HTTP",()=>{
 let admin:pg.Client,pool:pg.Pool,ops:pg.Pool,app:NestFastifyApplication,sessions:PgSessionStore,identity:IdentityService;
 let schema:string,role:string,base:string,ownerCookie:string,memberCookie:string,foreignCookie:string,auditUnavailable=false;
 const tenant=uuidv7(),other=uuidv7(),owner=uuidv7(),member=uuidv7(),foreign=uuidv7();
 const events:Record<string,unknown>[]=[];
 beforeAll(async()=>{
  schema="gov_http_"+randomUUID().replaceAll("-","_");role="gov_http_"+randomUUID().replaceAll("-","_");
  admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  for(const name of ["0000_platform_db_identity_foundation.sql","0001_identity_sessions_sso.sql","0002_signup_existing_membership.sql"])
   for(const sql of readFileSync(`apps/platform-api/src/db/migrations/${name}`,"utf8").split("--> statement-breakpoint").map(value=>value.trim()).filter(Boolean))await admin.query(sql);
  await applyMarketplaceMigrations(admin);
  await admin.query(readFileSync("apps/platform-api/src/db/migrations/0010_staff_plane.sql","utf8").split("--> statement-breakpoint")[0]!);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Seller','active'),($2,'Other seller','active')",[tenant,other]);
  for(const [id,scope,storedRole] of [[owner,tenant,"owner"],[member,tenant,"member"],[foreign,other,"owner"]]){
   await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,$2,$3,'active')",[id,`mock|${id}`,`${id}@example.test`]);
   await admin.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)",[uuidv7(),scope,id,storedRole]);
  }
  for(const [id,identityRef,roles,deactivated] of [["stf_review","auth0|review",["staff_security"],false],["stf_support","auth0|support",["staff_support"],false],["stf_disabled","auth0|disabled",["staff_admin"],true]])
   await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles,deactivated_at) VALUES($1,$2,$3,$4,$5)",[id,identityRef,`${id}@example.test`,roles,deactivated?new Date():null]);
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
  const ordinary=new URL(database!);ordinary.username=role;ordinary.password=password;ordinary.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:ordinary.href});
  const operations=new URL(database!);operations.searchParams.set("options",`-c search_path=${schema},public`);ops=new pg.Pool({connectionString:operations.href});
  sessions=new PgSessionStore(pool);identity=new IdentityService(new MockIdentityProvider(),sessions);
  ownerCookie="alter_access="+(await identity.issueSignupSession(owner,tenant)).accessToken;
  memberCookie="alter_access="+(await identity.issueSignupSession(member,tenant)).accessToken;
  foreignCookie="alter_access="+(await identity.issueSignupSession(foreign,other)).accessToken;
  vi.stubEnv("AUTH0_STAFF_DOMAIN","governance.staff.test");
  for(const key of ["ENGINE_BASE_URL","ADS_CORE_BASE_URL","COST_LEDGER_BASE_URL","AUDIT_SERVICE_BASE_URL","ENGINE_M2M_TOKEN_URL"])vi.stubEnv(key,"http://127.0.0.1:1");
  for(const key of ["EVAL_FACADE_TOKEN_REF","DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF","AUDIT_QUERY_SERVICE_TOKEN_REF","ENGINE_M2M_AUDIENCE","ENGINE_M2M_CLIENT_ID","ENGINE_M2M_CLIENT_SECRET_REF","CONNECTION_REGISTRY_SERVICE_TOKEN_REF","BILLING_SYNC_SERVICE_TOKEN_REF"])vi.stubEnv(key,"native-unused-reference");
  const realFetch=globalThis.fetch;
  vi.stubGlobal("fetch",async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
   if(String(input)!=="https://governance.staff.test/userinfo")return realFetch(input,init);
   const token=new Headers(init?.headers).get("authorization"),name=token==="Bearer reviewer"?"review":token==="Bearer support"?"support":token==="Bearer disabled"?"disabled":undefined;
   return name?Response.json({sub:`auth0|${name}`,email:`${name}@example.test`}):new Response("",{status:401});
  });
  const db=new PlatformDb(pool);
  const module=await Test.createTestingModule({imports:[MarketplaceGovernanceModule,EngineModule],controllers:[SellerGovernanceController],providers:[
   {provide:SellerGovernanceRepository,useValue:new SellerGovernanceRepository(pool)},
   {provide:APP_GUARD,useValue:new ActorContextGuard(identity,db)},
   {provide:APP_GUARD,useValue:new RbacGuard(new Reflector(),new WorkspaceResourceTenantResolver(new PlatformDbWorkspaceTenantLookup(db)),new ParamWorkspaceResolver())},
   {provide:APP_FILTER,useClass:RbacExceptionFilter},
  ]}).overrideProvider(StaffRepository).useValue(new StaffRepository(ops))
   .overrideProvider(MarketplaceGovernanceRepository).useValue(new MarketplaceGovernanceRepository(ops))
   .overrideProvider(ToolVersionReviewRepository).useValue(new ToolVersionReviewRepository(ops))
   .overrideProvider(AuditEventsClient).useValue({record:async(input:Record<string,unknown>)=>{if(auditUnavailable)throw new Error("Audit unavailable");events.push(input);return {entry_hash:"a".repeat(64)};}}).compile();
  app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.listen(0,"127.0.0.1");base=await app.getUrl();
 },60000);
 beforeEach(()=>{events.length=0;auditUnavailable=false;});
 afterAll(async()=>{await app?.close();await pool?.end();await ops?.end();vi.unstubAllGlobals();vi.unstubAllEnvs();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}});
 const staff="alter_staff_access=reviewer",staffPath="/api/v1/admin/marketplace/governance";
 const sellerPath=(id:string)=>`/api/v1/publisher/reviews/listing/${id}`;
 async function request<T=MarketplaceGovernanceItem>(path:string,cookie?:string,method="GET",body?:Record<string,unknown>,etag?:string){
  // eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- exercises this loopback Platform API through its actual cookie/session guards.
  const response=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{"content-type":"application/json"}:{}),...(etag?{"if-match":etag}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json() as T};
 }
 async function fixture(){const id=`lst_${uuidv7()}`;await admin.query("INSERT INTO listings(id,tenant_id,type,name,description,license_type,status) VALUES($1,$2,'workflow_template','HTTP mapping','Original description','single_workspace','human_review')",[id,tenant]);return id;}
 it("attributes staff changes then seller edits and resubmits through actual sessions and RLS",async()=>{
  expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  const id=await fixture(),queue=await request<MarketplaceGovernanceItem[]>(staffPath,staff),item=queue.body.find((value:{id:string})=>value.id===id)!;
  expect(queue.status).toBe(200);expect(item).toMatchObject({risk:{score:15,incomplete:true}});
  const changed=await request(`${staffPath}/listing/${id}/actions/apply`,staff,"POST",{action:"needs_changes",reason:"Correct HTTP mapping"},item.etag);
  expect(changed.status).toBe(201);expect(changed.body.review_notes![0]).toMatchObject({actor_ref:"stf_review",reason:"Correct HTTP mapping"});
  expect(events[0]).toMatchObject({actor_type:"admin",actor_ref:"stf_review",reason_code:"staff_decision"});
  const own=await request(sellerPath(id),ownerCookie);expect(own.status).toBe(200);expect(own.body.description).toBe("Original description");
  const corrected=await request(sellerPath(id),ownerCookie,"PATCH",{name:"Corrected HTTP mapping",description:"Saved correction",reason:"Corrected fields"},own.body.etag);
  expect(corrected.status).toBe(200);expect(corrected.body.status).toBe("needs_changes");expect(corrected.body.description).toBe("Saved correction");
  const resubmitted=await request(sellerPath(id)+"/actions/resubmit",ownerCookie,"POST",{reason:"Corrected and ready for review"},corrected.body.etag);
  expect(resubmitted.status).toBe(201);expect(resubmitted.body.status).toBe("submitted");expect(resubmitted.body.review_notes).toHaveLength(3);
  expect(events[2]).toMatchObject({actor_type:"user",actor_ref:owner,action:"marketplace.governance.resubmit"});
  expect((await request<MarketplaceGovernanceItem[]>(staffPath,staff)).body.find((value:{id:string})=>value.id===id)!).toMatchObject({name:"Corrected HTTP mapping",status:"submitted"});
 });
 it("denies unrelated actors, current revoked membership, forged fields, and stale or absent revisions",async()=>{
  const id=await fixture(),item=(await request<MarketplaceGovernanceItem[]>(staffPath,staff)).body.find((value:{id:string})=>value.id===id)!,path=`${staffPath}/listing/${id}/actions/apply`,body={action:"needs_changes",reason:"Correct fields"};
  for(const cookie of [undefined,ownerCookie,"alter_staff_access=support","alter_staff_access=disabled"])expect((await request(path,cookie,"POST",body,item.etag)).status).toBe(403);
  expect((await request(path,staff,"POST",body)).status).toBe(428);expect((await request(path,staff,"POST",body,'"stale"')).status).toBe(412);
  expect((await request(path,staff,"POST",{...body,actor_ref:"stf_spoof"},item.etag)).status).toBe(400);
  const changed=await request(path,staff,"POST",body,item.etag);
  expect((await request(sellerPath(id),foreignCookie)).status).toBe(404);
  expect((await request(sellerPath(id)+"/actions/resubmit",memberCookie,"POST",{reason:"Skip owner"},changed.body.etag)).status).toBe(403);
  expect((await request(sellerPath(id),ownerCookie,"PATCH",{name:"Other",reason:"Corrected",tenant_id:other},changed.body.etag)).status).toBe(400);
  await admin.query("UPDATE tenant_members SET role='member' WHERE user_id=$1 AND tenant_id=$2",[owner,tenant]);
  expect((await request(sellerPath(id)+"/actions/resubmit",ownerCookie,"POST",{reason:"Old owner"},changed.body.etag)).status).toBe(403);
  await admin.query("UPDATE tenant_members SET role='owner' WHERE user_id=$1 AND tenant_id=$2",[owner,tenant]);
 });
 it("rolls back staff and seller HTTP writes when mandatory audit is unavailable",async()=>{
  const id=await fixture(),item=(await request<MarketplaceGovernanceItem[]>(staffPath,staff)).body.find((value:{id:string})=>value.id===id)!,path=`${staffPath}/listing/${id}/actions/apply`;
  auditUnavailable=true;expect((await request(path,staff,"POST",{action:"needs_changes",reason:"Correct fields"},item.etag)).status).toBe(500);
  expect((await request(sellerPath(id),ownerCookie)).body).toMatchObject({status:"human_review",etag:item.etag,review_notes:[]});
  auditUnavailable=false;const changed=await request(path,staff,"POST",{action:"needs_changes",reason:"Correct fields"},item.etag);
  auditUnavailable=true;expect((await request(sellerPath(id),ownerCookie,"PATCH",{name:"Failed edit",reason:"Corrected fields"},changed.body.etag)).status).toBe(500);
  expect((await request(sellerPath(id)+"/actions/resubmit",ownerCookie,"POST",{reason:"Corrected"},changed.body.etag)).status).toBe(500);
  expect((await request(sellerPath(id),ownerCookie)).body).toMatchObject({status:"needs_changes",name:"HTTP mapping",etag:changed.body.etag,review_notes:[{action:"needs_changes"}]});
 });
});
