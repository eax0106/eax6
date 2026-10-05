import {randomUUID} from "node:crypto";
import {readdirSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {v7 as uuidv7} from "uuid";
import pg from "pg";
import {Test} from "@nestjs/testing";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {RbacModule} from "../rbac";
import {StaffService} from "../staff/staff.service";
import {StaffRepository} from "../staff/staff.repository";
import {StaffAuthMiddleware} from "../staff/staff.middleware";
import {AdminAuditService} from "../admin-audit";
import {AbuseSignalController} from "./abuse-signal.controller";
import {AbuseSignalService} from "./abuse-signal.service";
import {AbuseSignalRepository} from "./abuse-signal.repository";
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("security review current staff cookie assignment",()=>{
 let admin:pg.Client,pool:pg.Pool,app:NestFastifyApplication,schema:string,role:string,auditUnavailable=false;
 const tenant=uuidv7(),other=uuidv7(),id=`abs_${uuidv7()}`,foreign=`abs_${uuidv7()}`,events:Record<string,unknown>[]=[];
 const path="/api/v1/admin/abuse/signals",cookie={cookie:"alter_staff_access=valid-review-staff"};
 beforeAll(async()=>{
  schema="assign_"+randomUUID().replaceAll("-","_");role="assign_"+randomUUID().replaceAll("-","_");admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Review tenant','active'),($2,'Other tenant','active')",[tenant,other]);
  for(const [staff,roles,disabled] of [["stf_assign",["staff_security"],false],["stf_target",["staff_admin"],false],["stf_support",["staff_support"],false],["stf_disabled",["staff_security"],true]])await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles,deactivated_at) VALUES($1,$2,$3,$4,$5)",[staff,`auth0|${staff}`,`${staff}@example.test`,roles,disabled?new Date():null]);
  for(const [signal,scope] of [[id,tenant],[foreign,other]])await admin.query("INSERT INTO abuse_signals(id,tenant_id,signal_type,source,score,evidence_ref,source_fingerprint,observed_at) VALUES($1,$2,'payment_fraud','native.billing',60,'evt_actual',$1,now())",[signal,scope]);
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
  const url=new URL(database!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:url.href});
  const realFetch=globalThis.fetch;vi.stubEnv("AUTH0_STAFF_DOMAIN","assignment.staff.test");vi.stubGlobal("fetch",async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{if(String(input)!=="https://assignment.staff.test/userinfo")return realFetch(input,init);const bearer=new Headers(init?.headers).get("authorization");return bearer==="Bearer valid-review-staff"?Response.json({sub:"auth0|stf_assign",email:"staff@test.test"}):new Response("",{status:401});});
  const audit=new AdminAuditService({record:async(input:Record<string,unknown>)=>{if(auditUnavailable)throw new Error("Audit unavailable");events.push(input);return {entry_hash:"a".repeat(64)};}} as never);
  const staff=new StaffService(new StaffRepository(pool),audit),middleware=new StaffAuthMiddleware(staff),repository=new AbuseSignalRepository(pool,undefined,undefined);
  const module=await Test.createTestingModule({imports:[RbacModule],controllers:[AbuseSignalController],providers:[{provide:AbuseSignalService,useValue:new AbuseSignalService(repository,audit)}]}).compile();app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());app.getHttpAdapter().getInstance().addHook("preHandler",async(request,reply)=>middleware.use(request as unknown as Parameters<StaffAuthMiddleware["use"]>[0],reply,()=>{}));await app.init();await app.getHttpAdapter().getInstance().ready();
 },60000);
 beforeEach(()=>{auditUnavailable=false;events.length=0;});
 afterAll(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}vi.unstubAllGlobals();vi.unstubAllEnvs();},60000);
 const queue=()=>app.inject({method:"GET",url:path,headers:cookie});
 const assign=(signal:string,etag?:string,body:unknown={staff_user_id:"stf_target",reason:"Investigate actual provider evidence"},headers:Record<string,string>=cookie)=>app.inject({method:"POST",url:`${path}/${signal}/actions/assign`,headers:{...headers,"content-type":"application/json",...(etag?{"if-match":etag}:{})},payload:JSON.stringify(body)});
 it("assigns to an actual active staff member and retains attributed reason on reload",async()=>{
  expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
  const item=(await queue()).json().find((row:{id:string})=>row.id===id);const assigned=await assign(id,item.etag);expect(assigned.statusCode).toBe(201);
  expect(assigned.json()).toMatchObject({id,status:"open",assignment:{staff_user_id:"stf_target",staff_email:"stf_target@example.test",assigned_by:"stf_assign",reason:"Investigate actual provider evidence"}});
  expect(assigned.json().etag).not.toBe(item.etag);expect((await queue()).json()).toContainEqual(expect.objectContaining({id,assignment:expect.objectContaining({staff_user_id:"stf_target"})}));
  expect(events).toContainEqual(expect.objectContaining({actor_type:"admin",actor_ref:"stf_assign",tenant_id:tenant,action:"abuse.signal.assign",reason_code:"staff_assignment"}));
  expect((await queue()).json().find((row:{id:string})=>row.id===foreign).assignment).toBeNull();
  await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);
  expect((await admin.query("SELECT action,actor_ref,assignee_ref,reason,revision::text FROM abuse_signal_actions WHERE signal_id=$1",[id])).rows).toEqual([{action:"assign",actor_ref:"stf_assign",assignee_ref:"stf_target",reason:"Investigate actual provider evidence",revision:"2"}]);
 });
 it("lists only actual active eligible staff and requires current staff roles",async()=>{
  const picker=await app.inject({method:"GET",url:path+"/staff",headers:cookie});expect(picker.statusCode).toBe(200);expect(picker.json().map((row:{id:string})=>row.id)).toEqual(["stf_assign","stf_target"]);
  for(const headers of [{},{cookie:"alter_staff_access=expired"}])expect((await assign(id,undefined,undefined,headers)).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_support'] WHERE id='stf_assign'");expect((await app.inject({method:"GET",url:path+"/staff",headers:cookie})).statusCode).toBe(403);
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_security'] WHERE id='stf_assign'");
 });
 it("rejects missing and stale revisions, forged attribution and unavailable assignees",async()=>{
  const item=(await queue()).json().find((row:{id:string})=>row.id===id);
  expect((await assign(id)).statusCode).toBe(428);expect((await assign(id,'"stale"')).statusCode).toBe(412);expect((await assign(id,'*')).statusCode).toBe(412);
  for(const target of ["stf_disabled","stf_support","stf_missing"])expect((await assign(id,item.etag,{staff_user_id:target,reason:"Investigate"})).statusCode).toBe(409);
  for(const body of [{staff_user_id:"stf_target",reason:"",assigned_by:"stf_other"},{staff_user_id:"stf_target",reason:"Investigate",actor_ref:"stf_other"},{staff_user_id:"stf_target",reason:"x".repeat(1001)}])expect((await assign(id,item.etag,body)).statusCode).toBe(400);
 });
 it("rolls back assignment and review when mandatory audit acknowledgement fails",async()=>{
  const before=(await queue()).json().find((row:{id:string})=>row.id===id);auditUnavailable=true;
  expect((await assign(id,before.etag)).statusCode).toBe(500);expect((await queue()).json().find((row:{id:string})=>row.id===id)).toEqual(before);
  const review=await app.inject({method:"POST",url:`${path}/${id}/actions/review`,headers:{...cookie,"if-match":before.etag},payload:{decision:"confirm",reason:"Evidence confirmed"}});expect(review.statusCode).toBe(500);expect((await queue()).json().find((row:{id:string})=>row.id===id)).toEqual(before);
 });
 it("closes a reviewed signal while retaining its actual assignment and immutable reason history",async()=>{
  const item=(await queue()).json().find((row:{id:string})=>row.id===id);
  const review=await app.inject({method:"POST",url:`${path}/${id}/actions/review`,headers:{...cookie,"if-match":item.etag},payload:{decision:"dismiss",reason:"Recorded evidence does not confirm abuse"}});
  expect(review.statusCode).toBe(201);expect(review.json()).toMatchObject({status:"dismissed",assignment:{staff_user_id:"stf_target"}});
  expect((await assign(id,review.json().etag)).statusCode).toBe(409);
  expect((await app.inject({method:"POST",url:`${path}/${id}/actions/review`,headers:{...cookie,"if-match":review.json().etag},payload:{decision:"confirm",reason:"Cannot reopen"}})).statusCode).toBe(409);
  await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);
  expect((await admin.query("SELECT action,reason,actor_ref FROM abuse_signal_actions WHERE signal_id=$1 ORDER BY revision",[id])).rows).toEqual([
   {action:"assign",reason:"Investigate actual provider evidence",actor_ref:"stf_assign"},
   {action:"dismiss",reason:"Recorded evidence does not confirm abuse",actor_ref:"stf_assign"},
  ]);
  const tx=await pool.connect();
  try { await tx.query("BEGIN"); await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
   expect((await tx.query("UPDATE abuse_signal_actions SET reason='Overwrite history' WHERE signal_id=$1",[id])).rowCount).toBe(0);
   expect((await tx.query("DELETE FROM abuse_signal_actions WHERE signal_id=$1",[id])).rowCount).toBe(0);
  } finally { await tx.query("ROLLBACK"); tx.release(); }
  await expect(admin.query("UPDATE abuse_signal_actions SET reason='Overwrite history' WHERE signal_id=$1",[id])).rejects.toThrow(/append-only/);
 });
 it("serializes simultaneous assignments and reflects an assignee's later unavailability",async()=>{
  const signal=`abs_${uuidv7()}`;await admin.query("INSERT INTO abuse_signals(id,tenant_id,signal_type,source,score,evidence_ref,source_fingerprint,observed_at) VALUES($1,$2,'payment_fraud','native.concurrent',60,'evt_other',$1,now())",[signal,tenant]);
  const item=(await queue()).json().find((row:{id:string})=>row.id===signal);
  const responses=await Promise.all([assign(signal,item.etag,{staff_user_id:"stf_assign",reason:"First contender"}),assign(signal,item.etag,{staff_user_id:"stf_target",reason:"Second contender"})]);
  expect(responses.map(response=>response.statusCode).sort()).toEqual([201,412]);
  const current=(await queue()).json().find((row:{id:string})=>row.id===signal);
  await admin.query("UPDATE staff_users SET deactivated_at=now() WHERE id=$1",[current.assignment.staff_user_id]);
  if(current.assignment.staff_user_id==="stf_assign")await admin.query("UPDATE staff_users SET roles=ARRAY['staff_admin'] WHERE id='stf_target'");
  const repository=new AbuseSignalRepository(pool,undefined,undefined);
  expect((await repository.list()).find(row=>row.id===signal)!.assignment!.active).toBe(false);
  expect((await repository.eligibleStaff()).some(row=>row.id===current.assignment.staff_user_id)).toBe(false);
  await admin.query("UPDATE staff_users SET deactivated_at=NULL WHERE id=$1",[current.assignment.staff_user_id]);
 });
});
