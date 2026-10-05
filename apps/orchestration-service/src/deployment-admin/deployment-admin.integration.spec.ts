import {randomBytes} from "node:crypto";
import {resolve} from "node:path";
import {readFileSync} from "node:fs";
import {v7 as uuidv7} from "uuid";
import {PostgresOrchestrationStoreProvider} from "@alterx/adapters";
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from "@testcontainers/postgresql";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {DeploymentAdminService} from "./deployment-admin.service";

const tenant=uuidv7(),other=uuidv7(),empty=uuidv7(),workspace=uuidv7(),project=`prj_${uuidv7()}`,foreignProject=`prj_${uuidv7()}`;
describe.sequential("tenant deployments through actual ordinary PostgreSQL",()=>{
 let container:StartedPostgreSqlContainer,admin:PostgresOrchestrationStoreProvider,store:PostgresOrchestrationStoreProvider;
 let service:DeploymentAdminService,auditUnavailable=false,badAcknowledgement=false;
 const events:Record<string,unknown>[]=[];
 let pauseAudit:(()=>Promise<void>)|undefined;
 const local:string[]=[],foreign:string[]=[];
 beforeAll(async()=>{
  container=await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();
  const migrationsFolder=resolve("apps/orchestration-service/drizzle");
  admin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:container.getConnectionUri(),migrationsFolder});await admin.migrate();
  const role="deployment_"+randomBytes(6).toString("hex"),password=randomBytes(24).toString("hex");
  await admin.withTenant(tenant,async tx=>{await tx.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);});
  const uri=new URL(container.getConnectionUri());uri.username=role;uri.password=password;
  store=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:uri.href,migrationsFolder});
  service=new DeploymentAdminService(store,{recordEvent:async input=>{
   if(auditUnavailable)throw new Error("Audit unavailable");if(pauseAudit)await pauseAudit();events.push({...input});
   return {id:`aud_${uuidv7()}`,entry_hash:badAcknowledgement?"invalid":"a".repeat(64)};
  }});
  for(const [scope,parent] of [[tenant,project],[other,foreignProject]])await store.withTenant(scope!,async tx=>{
   await tx.query("INSERT INTO projects(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Recorded project')",[parent,scope,workspace]);
   for(let i=0;i<(scope===tenant?201:2);i++){
    const id=`dep_${uuidv7()}`;(scope===tenant?local:foreign).push(id);
    await tx.query("INSERT INTO deployments(id,tenant_id,project_id,status,created_at) VALUES($1,$2,$3,'pending','2026-10-05')",[id,scope,parent]);
   }
  });
  // Exercise the paired downgrade with populated legacy deployments and no history.
  const migration=readFileSync(resolve("apps/orchestration-service/drizzle/0055_deployment_admin_history.sql"),"utf8"),rollback=readFileSync(resolve("apps/orchestration-service/drizzle/rollback/0055_drop_deployment_admin_history.sql"),"utf8");
  await admin.withTenant(tenant,async tx=>{
   for(const sql of rollback.split("--> statement-breakpoint"))if(sql.trim())await tx.query(sql);
   expect((await tx.query("SELECT count(*)::text AS total FROM deployments WHERE tenant_id=$1",[tenant])).rows).toEqual([{total:"201"}]);
   expect((await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='deployments' AND column_name='revision'")).rows).toEqual([]);
   for(const sql of migration.split("--> statement-breakpoint"))if(sql.trim())await tx.query(sql);
   await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON deployment_admin_actions TO ${role}`);
  });
 },120000);
 beforeEach(()=>{auditUnavailable=false;badAcknowledgement=false;pauseAudit=undefined;events.length=0;});
 afterAll(async()=>{await store?.close();await admin?.close();await container?.stop();});
 it("returns the recorded named-tenant deployments with exact totals and stable bounded ordering",async()=>{
  await store.withTenant(tenant,async tx=>{
   expect((await tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
   expect((await tx.query("SELECT id FROM deployments WHERE tenant_id=$1",[other])).rows).toEqual([]);
  });
  const result=await service.list(tenant);
  expect(result).toMatchObject({tenant_id:tenant,total:201});expect(result.items).toHaveLength(200);
  expect(result.items.map(row=>row.id)).toEqual([...local].sort().reverse().slice(0,200));
  expect(result.items.every(row=>row.project_id===project&&row.status==="pending"&&row.etag)).toBe(true);
  expect(await service.list(tenant)).toEqual(result);
  expect((await service.list(other)).items.map(row=>row.id)).toEqual([...foreign].sort().reverse());
  expect(await service.list(empty)).toEqual({tenant_id:empty,total:0,items:[]});
 });
 async function fixture(statuses:string[]){
  const parent=`prj_${uuidv7()}`,ids:string[]=[];
  await store.withTenant(tenant,async tx=>{
   const run=`run_${uuidv7()}`,artifact=`art_${uuidv7()}`;
   await tx.query("INSERT INTO projects(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Action project')",[parent,tenant,workspace]);
   await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,project_id) VALUES($1,$2,$3,'project',$4)",[run,tenant,workspace,parent]);
   await tx.query("INSERT INTO artifacts(id,tenant_id,run_id,storage_reference,content_type,size_bytes) VALUES($1,$2,$3,'s3://fixture','text/plain',1)",[artifact,tenant,run]);
   for(const [index,status] of statuses.entries()){
    const id=`dep_${uuidv7()}`;ids.push(id);
    await tx.query("INSERT INTO deployments(id,tenant_id,project_id,status,artifact_id,destination_reference,created_at) VALUES($1,$2,$3,$4,$5,'s3://fixture/record',$6)",[id,tenant,parent,status,artifact,`2026-10-${10+index}T00:00:00Z`]);
   }
  });return ids;
 }
 const read=(id:string)=>store.withTenant(tenant,async tx=>(await tx.query<{id:string;status:string;revision:string;updated_at:Date}>("SELECT id,status,revision::text,updated_at FROM deployments WHERE id=$1",[id])).rows[0]!);
 const revision=async(id:string)=>{const row=await read(id);return `"${row.id}:rev-${row.revision}"`;};
 const apply=async(id:string,action:"suspend"|"resume"|"rollback",etag:string|undefined=undefined,reason="Recorded staff incident reason")=>service.apply({tenant_id:tenant,deployment_id:id,action,reason},"stf_deployment",etag);
 it("requires the exact displayed revision before changing a real deployment",async()=>{
  const [id]=await fixture(["active"]),before=await read(id!);
  await expect(apply(id!,"suspend")).rejects.toMatchObject({status:428});
  for(const stale of ['"stale"','*',`W/${await revision(id!)}`])await expect(apply(id!,"suspend",stale)).rejects.toMatchObject({status:412});
  expect(await read(id!)).toEqual(before);expect(events).toEqual([]);
 });
 it("suspends and resumes with monotonic revisions, full attributed reason and acknowledged audit",async()=>{
  const [id]=await fixture(["active"]),reason="文".repeat(1000),before=await revision(id!);
  const suspended=await apply(id!,"suspend",before,reason);expect(suspended).toMatchObject({status:"suspended",active_deployment_id:null,etag:`"${id}:rev-2"`});
  expect((await read(id!)).status).toBe("suspended");
  const resumed=await apply(id!,"resume",suspended.etag);expect(resumed).toMatchObject({status:"active",active_deployment_id:id,etag:`"${id}:rev-3"`});
  await expect(apply(id!,"suspend",before)).rejects.toMatchObject({status:412});
  const rows=await store.withTenant(tenant,tx=>tx.query("SELECT actor_ref,reason,action,revision::text FROM deployment_admin_actions WHERE deployment_id=$1 ORDER BY revision",[id]));
  expect(rows.rows).toEqual([{actor_ref:"stf_deployment",reason,action:"suspend",revision:"2"},{actor_ref:"stf_deployment",reason:"Recorded staff incident reason",action:"resume",revision:"3"}]);
  expect(events).toHaveLength(2);expect(events[0]).toMatchObject({tenant_id:tenant,actor_type:"admin",actor_ref:"stf_deployment",target_ref:id,action:"deployment.suspend",reason_code:"staff_deployment_action"});
  expect(JSON.parse(String(events[0]!.context_json)).scope).toMatch(/^deployments:write:history:daa_/);
 });
 it("restores only the latest prior rolled-back deployment and advances both revisions",async()=>{
  const ids=await fixture(["rolled_back","rolled_back","rolled_back","active"]),target=ids[3]!,replacement=ids[2]!;
  expect(await apply(target,"rollback",await revision(target))).toMatchObject({status:"rolled_back",active_deployment_id:replacement,etag:`"${target}:rev-2"`});
  expect(await read(replacement)).toMatchObject({status:"active",revision:"2"});expect(await read(ids[1]!)).toMatchObject({status:"rolled_back",revision:"1"});
  const history=await store.withTenant(tenant,tx=>tx.query("SELECT active_deployment_id,previous_status,next_status FROM deployment_admin_actions WHERE deployment_id=$1",[target]));
  expect(history.rows).toEqual([{active_deployment_id:replacement,previous_status:"active",next_status:"rolled_back"}]);
 });
 it("preserves existing transition rules and prevents another active deployment",async()=>{
  const [active,suspended,pending]=await fixture(["active","suspended","pending"]);
  await expect(apply(active!,"rollback",await revision(active!))).rejects.toThrow(/no previous/);
  await expect(apply(active!,"resume",await revision(active!))).rejects.toThrow(/Cannot resume/);
  await expect(apply(pending!,"suspend",await revision(pending!))).rejects.toThrow(/Cannot suspend/);
  await expect(apply(suspended!,"resume",await revision(suspended!))).rejects.toThrow(/already has active/);
  await expect(service.apply({tenant_id:other,deployment_id:active!,action:"suspend",reason:"Foreign scope"},"stf_deployment",await revision(active!))).rejects.toThrow(/not found/);
  expect(events).toEqual([]);
 });
 it("rolls back status, timestamp, revision and both-row rollback history on failed audit",async()=>{
  for(const action of ["suspend","rollback"] as const){
   const ids=await fixture(["rolled_back","active"]),target=ids[1]!,before=await read(target),previous=await read(ids[0]!);auditUnavailable=true;
   await expect(apply(target,action,await revision(target))).rejects.toThrow(/Audit unavailable/);auditUnavailable=false;
   expect(await read(target)).toEqual(before);expect(await read(ids[0]!)).toEqual(previous);
   expect((await store.withTenant(tenant,tx=>tx.query("SELECT id FROM deployment_admin_actions WHERE deployment_id=$1",[target]))).rows).toEqual([]);
  }
  const [id]=await fixture(["active"]);badAcknowledgement=true;
  await expect(apply(id!,"suspend",await revision(id!))).rejects.toThrow(/acknowledgement/);expect(await read(id!)).toMatchObject({status:"active",revision:"1"});
 });
 it("serializes same revision contenders and different-row resume contenders",async()=>{
  const [id]=await fixture(["active"]),etag=await revision(id!);
  const same=await Promise.allSettled([apply(id!,"suspend",etag),apply(id!,"suspend",etag)]);
  expect(same.filter(item=>item.status==="fulfilled")).toHaveLength(1);expect(same.find(item=>item.status==="rejected")).toMatchObject({reason:{status:412}});
  const [first,second]=await fixture(["suspended","suspended"]),firstTag=await revision(first!),secondTag=await revision(second!);
  const different=await Promise.allSettled([apply(first!,"resume",firstTag),apply(second!,"resume",secondTag)]);
  expect(different.filter(item=>item.status==="fulfilled")).toHaveLength(1);expect(different.find(item=>item.status==="rejected")).toMatchObject({reason:expect.objectContaining({message:expect.stringContaining("already has active")})});
 });
 it("holds the mutation uncommitted until mandatory audit acknowledges",async()=>{
  const [id]=await fixture(["active"]),before=await read(id!),etag=await revision(id!);
  let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  pauseAudit=()=>{entered();return new Promise<void>(resolve=>{release=resolve;});};
  const mutation=apply(id!,"suspend",etag);await waiting;
  try{expect(await read(id!)).toEqual(before);expect((await store.withTenant(tenant,tx=>tx.query("SELECT id FROM deployment_admin_actions WHERE deployment_id=$1",[id]))).rows).toEqual([]);}finally{release();}
  await mutation;expect(await read(id!)).toMatchObject({status:"suspended",revision:"2"});
 });
 it("retains FORCE RLS and immutable action fields, binds references and refuses destructive history downgrade",async()=>{
  const [id]=await fixture(["active"]);await apply(id!,"suspend",await revision(id!));
  const rows=await store.withTenant(tenant,tx=>tx.query<{id:string;revision:string}>("SELECT id,revision::text FROM deployment_admin_actions WHERE deployment_id=$1",[id]));const action=rows.rows[0]!;
  await store.withTenant(other,async tx=>{expect((await tx.query("SELECT id FROM deployment_admin_actions WHERE id=$1",[action.id])).rows).toEqual([]);expect((await tx.query("DELETE FROM deployment_admin_actions WHERE id=$1",[action.id])).rowCount).toBe(0);});
  await store.withTenant(tenant,async tx=>{expect((await tx.query("UPDATE deployment_admin_actions SET reason='Overwrite history' WHERE id=$1",[action.id])).rowCount).toBe(0);expect((await tx.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='deployment_admin_actions'")).rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);});
  await expect(admin.withTenant(tenant,tx=>tx.query("UPDATE deployment_admin_actions SET reason='Overwrite history' WHERE id=$1",[action.id]))).rejects.toThrow(/updates are not permitted/);
  const rollback=readFileSync(resolve("apps/orchestration-service/drizzle/rollback/0055_drop_deployment_admin_history.sql"),"utf8");
  await expect(admin.withTenant(tenant,async tx=>{for(const sql of rollback.split("--> statement-breakpoint"))if(sql.trim())await tx.query(sql);})).rejects.toThrow(/retained deployment action history/);
  expect((await store.withTenant(tenant,tx=>tx.query("SELECT id FROM deployment_admin_actions WHERE id=$1",[action.id]))).rows).toEqual([{id:action.id}]);
  await expect(store.withTenant(other,tx=>tx.query("INSERT INTO deployment_admin_actions(id,tenant_id,deployment_id,actor_ref,action,reason,previous_status,next_status,revision) VALUES($1,$2,$3,'stf_fixture','suspend','Scope mismatch','active','suspended',2)",[`daa_${uuidv7()}`,other,id]))).rejects.toThrow(/foreign key/);
 });
});
