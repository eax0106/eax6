import {randomUUID} from "node:crypto";
import {readFileSync,readdirSync} from "node:fs";
import {resolve} from "node:path";
import {v7 as uuidv7} from "uuid";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {AbuseSignalRepository} from "./abuse-signal.repository";
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("security assignment ordinary PostgreSQL history and rollback",()=>{
 let admin:pg.Client,pool:pg.Pool,schema:string,role:string,repository:AbuseSignalRepository;
 const tenant=uuidv7(),other=uuidv7(),id=`abs_${uuidv7()}`,foreign=`abs_${uuidv7()}`;
 beforeAll(async()=>{
  schema="assignment_store_"+randomUUID().replaceAll("-","_");role="assignment_store_"+randomUUID().replaceAll("-","_");admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Assignment A','active'),($2,'Assignment B','active')",[tenant,other]);
  await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_storage','auth0|assignment-storage','storage@example.test',ARRAY['staff_security'])");
  for(const [signal,scope] of [[id,tenant],[foreign,other]])await admin.query("INSERT INTO abuse_signals(id,tenant_id,signal_type,source,score,evidence_ref,source_fingerprint,observed_at) VALUES($1,$2,'payment_fraud','storage.fixture',60,'evt_source',$1,now())",[signal,scope]);
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
  const url=new URL(database!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:url.href});repository=new AbuseSignalRepository(pool,undefined,undefined);
 },60000);
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}},60000);
 const one=async(signal=id)=>(await repository.list()).find(row=>row.id===signal)!;
 it("downgrades an unused assignment schema without rewriting existing review evidence, then reapplies",async()=>{
  const legacy=`abs_${randomUUID()}`;await admin.query("INSERT INTO abuse_signals(id,tenant_id,signal_type,source,score,evidence_ref,source_fingerprint,observed_at,status,reviewed_by,reviewed_at,review_reason) VALUES($1,$2,'credential_abuse','legacy.fixture',40,'evt_legacy',$1,now(),'confirmed','stf_storage',now(),'Retained legacy decision')",[legacy,tenant]);
  const execute=async(path:string)=>{for(const sql of readFileSync(path,"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);};
  await execute("apps/platform-api/src/db/migrations/rollback/0036_drop_security_review_assignment.sql");
  expect((await admin.query("SELECT status,reviewed_by,review_reason FROM abuse_signals WHERE id=$1",[legacy])).rows[0]).toEqual({status:"confirmed",reviewed_by:"stf_storage",review_reason:"Retained legacy decision"});
  await execute("apps/platform-api/src/db/migrations/0036_security_review_assignment.sql");
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON abuse_signal_actions TO ${role}`);await admin.query(`GRANT EXECUTE ON FUNCTION erase_tenant_abuse_signal_actions(uuid,text) TO ${role}`);
  expect((await one(legacy)).assignment).toBeNull();expect((await one(legacy)).etag).toContain(":rev-1");
 });
 it("retains full Unicode reasons and rejects destructive downgrade with actual history",async()=>{
  const reason="文".repeat(1000),before=await one();
  const updated=await repository.assign(id,"stf_storage",reason,"stf_storage",{ifMatch:before.etag,audit:async()=>"acknowledged"});
  expect(updated!.assignment!.reason).toBe(reason);expect(updated!.etag).not.toBe(before.etag);
  expect((await pool.query("SELECT count(*)::int AS n FROM abuse_signal_actions")).rows[0]!.n).toBe(0);
  await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);
  expect((await admin.query("SELECT reason FROM abuse_signal_actions WHERE signal_id=$1",[id])).rows[0]!.reason).toBe(reason);
  const rollback=readFileSync("apps/platform-api/src/db/migrations/rollback/0036_drop_security_review_assignment.sql","utf8").split("--> statement-breakpoint")[0]!;
  await expect(admin.query(rollback)).rejects.toThrow("retained security review history");
  await expect(admin.query("DELETE FROM abuse_signal_actions WHERE signal_id=$1",[id])).rejects.toThrow("append-only");
 });
 it("uses monotonic revisions for refresh writes and binds a history row to its actual tenant and signal",async()=>{
  const before=await one();await admin.query("UPDATE abuse_signals SET revision=99999,score=70 WHERE id=$1",[id]);const after=await one();
  expect(after.etag).not.toBe(before.etag);expect(after.etag).toContain(":rev-3");
  await expect(repository.assign(id,"stf_storage","Stale write","stf_storage",{ifMatch:before.etag,audit:async()=>"ack"})).rejects.toMatchObject({status:412});
  const tx=await pool.connect();try{await tx.query("BEGIN");await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
   await expect(tx.query("INSERT INTO abuse_signal_actions(id,tenant_id,signal_id,action,actor_ref,assignee_ref,reason,revision) VALUES($1,$2,$3,'assign','stf_storage','stf_storage','Incorrect signal scope',2)",[`asa_${uuidv7()}`,tenant,foreign])).rejects.toMatchObject({code:"23503"});
  }finally{await tx.query("ROLLBACK");tx.release();}
 });
 it("requires a matching active manifest and leaves other tenant history intact",async()=>{
  await repository.assign(foreign,"stf_storage","Other tenant review","stf_storage",{ifMatch:(await one(foreign)).etag,audit:async()=>"ack"});
  const manifest=`del_${uuidv7()}`;
  await expect(pool.query("SELECT erase_tenant_abuse_signal_actions($1,$2)",[tenant,manifest])).rejects.toThrow("no active erasure manifest");
  await admin.query("INSERT INTO tenant_erasure_manifests(manifest_id,tenant_id) VALUES($1,$2)",[manifest,tenant]);
  await expect(pool.query("SELECT erase_tenant_abuse_signal_actions($1,$2)",[other,manifest])).rejects.toThrow("no active erasure manifest");
  expect((await pool.query("SELECT erase_tenant_abuse_signal_actions($1,$2) AS n",[tenant,manifest])).rows[0]!.n).toBe(1);
  await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[other]);expect((await admin.query("SELECT count(*)::int AS n FROM abuse_signal_actions WHERE tenant_id=$1",[other])).rows[0]!.n).toBe(1);
 });
 it("holds the live tenant through audit and refuses a deleted subject without retaining a late assignment",async()=>{
  const scope=uuidv7(),signal=`abs_${uuidv7()}`;
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Serialized assignment','active')",[scope]);
  await admin.query("INSERT INTO abuse_signals(id,tenant_id,signal_type,source,score,evidence_ref,source_fingerprint,observed_at) VALUES($1,$2,'payment_fraud','serialized.fixture',60,'evt_serialized',$1,now())",[signal,scope]);
  let acknowledge!:()=>void,arrived!:()=>void;
  const auditStarted=new Promise<void>(resolve=>{arrived=resolve;}),auditReleased=new Promise<void>(resolve=>{acknowledge=resolve;});
  const pending=repository.assign(signal,"stf_storage","Serialized human reason","stf_storage",{ifMatch:(await one(signal)).etag,audit:async()=>{arrived();await auditReleased;}});
  await auditStarted;
  const erasure=await pool.connect();
  try{
   await erasure.query("BEGIN");await erasure.query("SELECT set_config('app.current_tenant_id',$1,true)",[scope]);await erasure.query("SET LOCAL statement_timeout='100ms'");
   await expect(erasure.query("UPDATE tenants SET deleted_at=now() WHERE id=$1",[scope])).rejects.toMatchObject({code:"57014"});
  }finally{await erasure.query("ROLLBACK");erasure.release();acknowledge();}
  const assigned=await pending;expect(assigned!.assignment!.reason).toBe("Serialized human reason");
  await admin.query("UPDATE tenants SET deleted_at=now() WHERE id=$1",[scope]);
  expect(await repository.assign(signal,"stf_storage","Late assignment","stf_storage",{ifMatch:assigned!.etag,audit:async()=>"ack"})).toBeUndefined();
  await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[scope]);
  expect((await admin.query("SELECT count(*)::int AS n FROM abuse_signal_actions WHERE signal_id=$1",[signal])).rows[0]!.n).toBe(1);
 });
});
