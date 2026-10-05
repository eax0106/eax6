import {randomUUID} from "node:crypto";
import {readdirSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {Test} from "@nestjs/testing";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {RbacModule} from "../rbac";
import {StaffAuthMiddleware} from "../staff/staff.middleware";
import {StaffRepository} from "../staff/staff.repository";
import {StaffService} from "../staff/staff.service";
import {AdminUsersController} from "./admin-users.controller";
import {AdminUsersService} from "./admin-users.service";
import {AdminUsersRepository} from "./admin-users.repository";
import {AdminTenantsController} from "../admin-tenants/admin-tenants.controller";
import {AdminTenantsService} from "../admin-tenants/admin-tenants.service";
import {AdminTenantsRepository} from "../admin-tenants/admin-tenants.repository";
import {ENTITLEMENT_PROVIDER} from "../entitlements/entitlement-provider.interface";
import {AdminAuditService} from "../admin-audit";
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("notes current staff cookie and ordinary PostgreSQL",()=>{
 let admin:pg.Client,pool:pg.Pool,app:NestFastifyApplication,schema:string,role:string;
 const record=vi.fn(async()=>"audit-acknowledgement");
 const tenantA=randomUUID(),tenantB=randomUUID(),userId=randomUUID();
 const cookie={cookie:"alter_staff_access=history-valid-test-token"};
 beforeAll(async()=>{
  schema="history_"+randomUUID().replaceAll("-","_");role="history_"+randomUUID().replaceAll("-","_");
  admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'A','active'),($2,'B','active')",[tenantA,tenantB]);
  await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,'auth0|notes-subject','subject@tenant.test','active')",[userId]);
  await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_history','auth0|history','history@staff.test',ARRAY['staff_admin'])");
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT EXECUTE ON FUNCTION admin_list_users(uuid) TO ${role}`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO platform_provisioner`);
  const url=new URL(database!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema}`);pool=new pg.Pool({connectionString:url.href});
  vi.stubEnv("AUTH0_STAFF_DOMAIN","history.staff.test");vi.stubGlobal("fetch",vi.fn(async(_url,options?:RequestInit)=>new Headers(options?.headers).get("authorization")==="Bearer history-valid-test-token"?Response.json({sub:"auth0|history",email:"history@staff.test"}):Response.json({error:"expired"},{status:401})));
  const staff=new StaffService(new StaffRepository(pool),{record} as unknown as AdminAuditService),middleware=new StaffAuthMiddleware(staff);
  const module=await Test.createTestingModule({imports:[RbacModule],controllers:[AdminUsersController,AdminTenantsController],providers:[
   AdminUsersService,AdminTenantsService,{provide:AdminUsersRepository,useValue:new AdminUsersRepository(pool)},
   {provide:AdminTenantsRepository,useValue:new AdminTenantsRepository(pool)},
   {provide:AdminAuditService,useValue:{record}},{provide:StaffService,useValue:staff},{provide:ENTITLEMENT_PROVIDER,useValue:{}},
  ]}).compile();
  app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());app.getHttpAdapter().getInstance().addHook("preHandler",async(request,reply)=>middleware.use(request as unknown as Parameters<StaffAuthMiddleware["use"]>[0],reply,()=>{}));await app.init();await app.getHttpAdapter().getInstance().ready();
 },60000);
 afterAll(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}vi.unstubAllGlobals();vi.unstubAllEnvs();},60000);
 it("requires current authenticated staff and scoped tenant access for append and history",async()=>{
  expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
  const userNote=(headers:Record<string,string>={},body:unknown={body:"User investigation"})=>app.inject({method:"POST",url:`/api/v1/admin/users/${userId}/notes`,headers:{...headers,"content-type":"application/json"},payload:JSON.stringify(body)});
  for(const headers of [{},{cookie:"alter_staff_access=expired-test-token"}]) {
   expect((await userNote(headers)).statusCode).toBe(403);
   expect((await app.inject({method:"GET",url:`/api/v1/admin/users/${userId}/actions`,headers})).statusCode).toBe(403);
  }
  const created=await userNote(cookie);expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({reason:"User investigation",staff_email:"history@staff.test"});
  expect(record).toHaveBeenCalledWith(expect.objectContaining({actorRef:"stf_history",action:"user.note.append",targetRef:created.json().id}));
  record.mockRejectedValueOnce(new Error("Audit temporarily unavailable"));
  expect((await userNote(cookie,{body:"Must roll back"})).statusCode).toBe(500);
  expect((await pool.query("SELECT reason FROM user_admin_actions WHERE user_id=$1",[userId])).rows).toEqual([{reason:"User investigation"}]);
  for(const body of [{},{body:"   "},{body:"a".repeat(4001)},{body:"note",other:1}])expect((await userNote(cookie,body)).statusCode).toBe(400);
  expect((await app.inject({method:"POST",url:`/api/v1/admin/users/${randomUUID()}/notes`,headers:cookie,payload:{body:"Unknown subject"}})).statusCode).toBe(404);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_billing_ops'] WHERE id='stf_history'");expect((await userNote(cookie)).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_support'] WHERE id='stf_history'");
  const grantId="jit_"+randomUUID();await admin.query("INSERT INTO jit_grants(id,staff_user_id,tenant_id,reason_code,reason_text,expires_at,scopes) VALUES($1,'stf_history',$2,'support_investigation','Notes access',now()+interval '1 hour',ARRAY['tenant:read'])",[grantId,tenantA]);
  const tenantNote=(tenant=tenantA,headers:Record<string,string>=cookie)=>app.inject({method:"POST",url:`/api/v1/admin/tenants/${tenant}/notes`,headers,payload:{body:"Tenant investigation"}});
  expect((await tenantNote()).statusCode).toBe(403);
  expect((await app.inject({method:"GET",url:`/api/v1/admin/tenants/${tenantA}/actions`,headers:cookie})).statusCode).toBe(403);
  const scoped={...cookie,"x-alter-support-grant":grantId};expect((await tenantNote(tenantB,scoped)).statusCode).toBe(403);
  expect((await app.inject({method:"GET",url:`/api/v1/admin/tenants/${tenantB}/actions`,headers:scoped})).statusCode).toBe(403);
  expect((await tenantNote(tenantA,scoped)).statusCode).toBe(201);
  expect((await app.inject({method:"GET",url:`/api/v1/admin/tenants/${tenantA}/actions`,headers:scoped})).json()).toContainEqual(expect.objectContaining({action:"note_added",reason:"Tenant investigation"}));
  await admin.query("UPDATE jit_grants SET granted_at=now()-interval '2 hours',expires_at=now()-interval '1 second' WHERE id=$1",[grantId]);expect((await tenantNote(tenantA,scoped)).statusCode).toBe(403);
  await admin.query("UPDATE jit_grants SET expires_at=now()+interval '1 hour',revoked_at=now() WHERE id=$1",[grantId]);expect((await tenantNote(tenantA,scoped)).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET deactivated_at=now() WHERE id='stf_history'");expect((await userNote(cookie)).statusCode).toBe(403);
  expect((await app.inject({method:"GET",url:`/api/v1/admin/users/${userId}/actions`,headers:cookie})).statusCode).toBe(403);
 });
});
