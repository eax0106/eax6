import {randomUUID} from "node:crypto";
import {v7 as uuidv7} from "uuid";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import pg from "pg";
import {SellerGovernanceRepository} from "../publisher/seller-governance.repository";
import {RegistryRepository} from "../registry/registry.repository";
import {ToolVersionReviewRepository} from "./tool-version-review.repository";
import {governanceEtag} from "./governance-history";
import {MarketplaceGovernanceRepository} from "./marketplace-governance.repository";
import {computeEtag} from "../concurrency/etag";
import {applyMarketplaceMigrations} from "../db/marketplace-migrator";
const database=process.env.MARKETPLACE_DATABASE_URL;
describe.skipIf(!database)("marketplace governance history ordinary PostgreSQL",()=>{
 let admin:pg.Client,pool:pg.Pool,schema:string,role:string;
 const tenant=uuidv7(),other=uuidv7();
 const listing=`lst_${uuidv7()}`;
 beforeEach(async()=>{
  schema="gov_"+randomUUID().replaceAll("-","_");role="gov_"+randomUUID().replaceAll("-","_");
  admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  await applyMarketplaceMigrations(admin);
  await admin.query("INSERT INTO listings(id,tenant_id,type,name,license_type,status) VALUES($1,$2,'workflow_template','Review workflow','single_workspace','human_review')",[listing,tenant]);
  const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const url=new URL(database!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:url.href});
 });
 afterEach(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}});
 async function scoped<T>(value:string,fn:(client:pg.PoolClient)=>Promise<T>){
  const client=await pool.connect();try{await client.query("BEGIN");await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[value]);const result=await fn(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 }
 async function event(client:pg.PoolClient,reason="Explain the requested change",eventTenant=tenant){
  const id=`mge_${uuidv7()}`;
  await client.query(`INSERT INTO marketplace_governance_events(id,tenant_id,resource_type,resource_id,actor_type,actor_ref,action,previous_status,next_status,reason,resource_revision)
   VALUES($1,$2,'listing',$3,'staff','stf_review','needs_changes','human_review','needs_changes',$4,1)`,[id,eventTenant,listing,reason]);return id;
 }
 it("persists attributed notes, refuses mutation, and defaults to no visible history",async()=>{
  expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
  const id=await scoped(tenant,client=>event(client));
  expect((await pool.query("SELECT * FROM marketplace_governance_events")).rows).toEqual([]);
  await scoped(tenant,async client=>{
   expect((await client.query("SELECT actor_ref,reason,action FROM marketplace_governance_events WHERE id=$1",[id])).rows).toEqual([{actor_ref:"stf_review",reason:"Explain the requested change",action:"needs_changes"}]);
  });
  expect((await scoped(tenant,client=>client.query("UPDATE marketplace_governance_events SET reason='Edited' WHERE id=$1",[id]))).rowCount).toBe(0);
  expect((await scoped(tenant,client=>client.query("DELETE FROM marketplace_governance_events WHERE id=$1",[id]))).rowCount).toBe(0);
  await expect(admin.query("UPDATE marketplace_governance_events SET reason='Edited' WHERE id=$1",[id])).rejects.toThrow("append-only");
  await expect(admin.query("DELETE FROM marketplace_governance_events WHERE id=$1",[id])).rejects.toThrow("append-only");
  expect(await scoped(other,async client=>(await client.query("SELECT * FROM marketplace_governance_events")).rows)).toEqual([]);
  await expect(scoped(other,client=>event(client,"Other tenant",tenant))).rejects.toThrow(/row-level security/);
 });
 it("rejects blank and overlong reasons and non-v7 event ids at the database boundary",async()=>{
  for(const reason of ["","  ","x".repeat(1001)])await expect(scoped(tenant,client=>event(client,reason))).rejects.toThrow(/check constraint/);
  await expect(scoped(tenant,client=>client.query(`INSERT INTO marketplace_governance_events(id,tenant_id,resource_type,resource_id,actor_type,actor_ref,action,previous_status,next_status,reason,resource_revision)
   VALUES($1,$2,'listing',$3,'staff','stf_review','needs_changes','human_review','needs_changes','Review',1)`,[`mge_${randomUUID()}`,tenant,listing]))).rejects.toThrow(/check constraint/);
 });
 it("rolls back a staff decision when mandatory audit fails",async()=>{
  // Use the same ordinary-role credentials without exposing them in output.
  const connection=await pool.connect();
  const repository=new MarketplaceGovernanceRepository({connect:async()=>{
   await connection.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);
   return {query:connection.query.bind(connection),release:()=>{}};
  }} as unknown as pg.Pool);
  try{
   await expect(repository.act("listing",listing,{action:"reject",reason:"Explain failed review"},{actorRef:"stf_review",ifMatch:computeEtag(null,`${listing}:0`),audit:async()=>{throw new Error("audit unavailable");}})).rejects.toThrow("audit unavailable");
   expect((await scoped(tenant,c=>c.query("SELECT status,governance_revision::text FROM listings WHERE id=$1",[listing]))).rows).toEqual([{status:"human_review",governance_revision:"0"}]);
   expect((await scoped(tenant,c=>c.query("SELECT * FROM marketplace_governance_events"))).rows).toEqual([]);
  }finally{connection.release();}
 });
 function ordinaryOperations(value=tenant){
  return new MarketplaceGovernanceRepository({connect:async()=>{const c=await pool.connect();await c.query("SELECT set_config('app.current_tenant_id',$1,false)",[value]);return c;}} as unknown as pg.Pool);
 }
 it("retains attributed reasons, rejects stale decisions and only returns requested changes after seller resubmission",async()=>{
  const reviews=ordinaryOperations(),seller=new SellerGovernanceRepository(pool);
  const notes=await reviews.act("listing",listing,{action:"needs_changes",reason:"Correct the field mapping"},{actorRef:"stf_review",ifMatch:governanceEtag(listing,0),audit:async()=>{}});
  expect(notes).toMatchObject({status:"needs_changes",etag:governanceEtag(listing,1),review_notes:[{actor_ref:"stf_review",reason:"Correct the field mapping",action:"needs_changes"}]});
  let audits=0;
  await expect(reviews.act("listing",listing,{action:"reject",reason:"Outdated"},{actorRef:"stf_review",ifMatch:governanceEtag(listing,0),audit:async()=>{audits++;}})).rejects.toMatchObject({status:412});
  expect(audits).toBe(0);
  await expect(reviews.act("listing",listing,{action:"approve",reason:"Skip seller"},{actorRef:"stf_review",ifMatch:notes!.etag,audit:async()=>{}})).rejects.toThrow("seller must resubmit");
  await expect(seller.review(other,"listing",listing)).rejects.toMatchObject({status:404});
  await expect(seller.resubmit(other,"listing",listing,"usr_other","Corrected",notes!.etag,async()=>{})).rejects.toMatchObject({status:404});
  await seller.edit(tenant,"listing",listing,"usr_seller",{name:"Corrected mapping",description:"Actual saved correction",reason:"Corrected field mapping"},notes!.etag,async()=>{});
  await expect(seller.resubmit(tenant,"listing",listing,"usr_seller","Corrected",notes!.etag,async()=>{})).rejects.toMatchObject({status:412});
  const current=await seller.review(tenant,"listing",listing);
  const result=await seller.resubmit(tenant,"listing",listing,"usr_seller","Corrected field mapping",current.etag,async()=>{audits++;});
  expect(result).toMatchObject({status:"submitted",name:"Corrected mapping",etag:governanceEtag(listing,3)});
  expect(result.review_notes).toHaveLength(3);expect(result.review_notes![0]).toMatchObject({actor_type:"seller",actor_ref:"usr_seller",action:"resubmit",reason:"Corrected field mapping"});
  expect(audits).toBe(1);
  await expect(seller.resubmit(tenant,"listing",listing,"usr_seller","Repeated",result.etag,async()=>{})).rejects.toMatchObject({status:409});
 });
 it("keeps requested changes and history intact when seller audit is unavailable",async()=>{
  await scoped(tenant,c=>c.query("UPDATE listings SET status='needs_changes' WHERE id=$1",[listing]));
  const seller=new SellerGovernanceRepository(pool),current=await seller.review(tenant,"listing",listing);
  await expect(seller.resubmit(tenant,"listing",listing,"usr_seller","Corrected",current.etag,async()=>{throw new Error("seller audit unavailable");})).rejects.toThrow("seller audit unavailable");
  expect(await seller.review(tenant,"listing",listing)).toMatchObject({status:"needs_changes",etag:current.etag,review_notes:[]});
 });
 it("requires a pinned revision and cannot approve a paid or versionless listing",async()=>{
  const reviews=ordinaryOperations();
  for(const match of [undefined,"*"]){await expect(reviews.act("listing",listing,{action:"reject",reason:"Review"},{actorRef:"stf_review",ifMatch:match,audit:async()=>{}})).rejects.toMatchObject({status:match===undefined?428:412});}
  await expect(reviews.act("listing",listing,{action:"approve",reason:"Review"},{actorRef:"stf_review",ifMatch:governanceEtag(listing,0),audit:async()=>{}})).rejects.toThrow("listing version is required");
  await scoped(tenant,c=>c.query("UPDATE listings SET price_minor=100 WHERE id=$1",[listing]));
  await expect(reviews.act("listing",listing,{action:"approve",reason:"Review"},{actorRef:"stf_review",ifMatch:governanceEtag(listing,1),audit:async()=>{}})).rejects.toThrow("Only free listings");
 });
 it("uses current scan pointers and actual seller history to sort risk without changing status",async()=>{
  const manifest=`tlm_${uuidv7()}`,version=`tlv_${uuidv7()}`,oldScan=`scn_${uuidv7()}`,latestScan=`scn_${uuidv7()}`;
  await admin.query("UPDATE listings SET created_at='2026-01-01',updated_at='2026-01-01' WHERE id=$1",[listing]);
  await admin.query("INSERT INTO tool_manifests(id,tenant_id,name,ecosystem,trust_level,status) VALUES($1,$2,'Review tool','npm','community_reviewed','draft')",[manifest,tenant]);
  await admin.query("INSERT INTO tool_versions(id,manifest_id,version,artifact_ref,capabilities_json,permissions_json,status) VALUES($1,$2,'1.0.0','s3://fixture/tool','[\"email.send\",\"database.select\"]','[\"mail:send\"]','review_pending')",[version,manifest]);
  for(const [id,verdict,time] of [[oldScan,"blocked","2026-01-01"],[latestScan,"clean","2026-02-01"]])await admin.query("INSERT INTO tool_scan_reports(id,tenant_id,tool_version_id,verdict,findings_json,scanner_version,duration_ms,scanned_at) VALUES($1,$2,$3,$4,'[]','fixture',1,$5)",[id,tenant,version,verdict,time]);
  await admin.query("UPDATE tool_versions SET latest_scan_report_id=$2 WHERE id=$1",[version,latestScan]);
  await admin.query(`INSERT INTO marketplace_governance_events(id,tenant_id,resource_type,resource_id,actor_type,actor_ref,action,previous_status,next_status,reason,resource_revision)
    VALUES($1,$2,'listing','lst_prior','staff','stf_review','takedown','published','removed','Prior withdrawn listing',1)`,[`mge_${uuidv7()}`,tenant]);
  const reviews=new MarketplaceGovernanceRepository({query:admin.query.bind(admin)} as unknown as pg.Pool);
  const queue=await reviews.list();
  expect(queue.map(item=>item.id)).toEqual([manifest,listing]);
  expect(queue[0]).toMatchObject({status:"draft",risk:{score:45,incomplete:false}});
  expect(queue[0]!.risk!.reasons).toContainEqual(expect.objectContaining({signal:"scanner",points:0,evidence:[latestScan]}));
  expect(queue[0]!.risk!.reasons).toContainEqual(expect.objectContaining({signal:"outside_actions",points:20,evidence:["email.send"]}));
  expect(queue[1]).toMatchObject({status:"human_review",risk:{score:25,incomplete:true}});
  expect((await admin.query("SELECT status FROM tool_manifests WHERE id=$1",[manifest])).rows[0].status).toBe("draft");
 });
 it("prioritizes an older high-risk resource before applying the bounded queue limit",async()=>{
  const ids=Array.from({length:201},()=>`tlm_${uuidv7()}`),old=`tlm_${uuidv7()}`,version=`tlv_${uuidv7()}`,scan=`scn_${uuidv7()}`;
  await admin.query(`INSERT INTO tool_manifests(id,tenant_id,name,ecosystem,trust_level,status,created_at,updated_at)
    SELECT id,$2,id,'npm','community_reviewed','draft','2026-02-01','2026-02-01' FROM unnest($1::text[]) AS id`,[ids,tenant]);
  await admin.query("INSERT INTO tool_manifests(id,tenant_id,name,ecosystem,trust_level,status,created_at,updated_at) VALUES($1,$2,'Older high risk','npm','community_reviewed','draft','2026-01-01','2026-01-01')",[old,tenant]);
  await admin.query("INSERT INTO tool_versions(id,manifest_id,version,artifact_ref,capabilities_json,permissions_json,status) VALUES($1,$2,'1.0.0','s3://fixture/old','[\"email.send\"]','[\"mail:send\"]','scan_failed')",[version,old]);
  await admin.query("INSERT INTO tool_scan_reports(id,tenant_id,tool_version_id,verdict,findings_json,scanner_version,duration_ms,scanned_at) VALUES($1,$2,$3,'blocked','[]','native',1,'2026-01-01')",[scan,tenant,version]);
  await admin.query("UPDATE tool_versions SET latest_scan_report_id=$2 WHERE id=$1",[version,scan]);
  const queue=await new MarketplaceGovernanceRepository({query:admin.query.bind(admin)} as unknown as pg.Pool).list();
  expect(queue[0]).toMatchObject({id:old,risk:{score:85,incomplete:false}});expect(queue).toHaveLength(200);
 });
 it("prevents clean scans and version reviews from publishing a tool while changes are requested",async()=>{
  const registry=new RegistryRepository(pool),manifest=`tlm_${uuidv7()}`,first=`tlv_${uuidv7()}`,scanId=`scn_${uuidv7()}`;
  await registry.createManifest(tenant,manifest,{name:"Changes package",ecosystem:"npm",trust_level:"community_reviewed"});
  await registry.createVersion(tenant,first,manifest,{version:"1.0.0",artifact_ref:"s3://fixture/tool",capabilities:[],permissions:[]});
  const clean={verdict:"clean" as const,findings:[],scannerVersion:"native",durationMs:1,scannedAt:new Date().toISOString()};
  await registry.beginScan(tenant,manifest,first);await registry.completeScan(tenant,manifest,first,scanId,clean);
  const ops=new ToolVersionReviewRepository({connect:async()=>{const c=await pool.connect();await c.query("SELECT set_config('app.current_tenant_id',$1,false)",[tenant]);return c;}} as unknown as pg.Pool);
  await ops.review(manifest,first,"stf_review",{scanReportId:scanId,decision:"approved",reason:"First clean version"},async()=>{});
  await scoped(tenant,c=>c.query("UPDATE tool_manifests SET status='needs_changes' WHERE id=$1",[manifest]));
  const second=`tlv_${uuidv7()}`,secondScan=`scn_${uuidv7()}`;
  await registry.createVersion(tenant,second,manifest,{version:"2.0.0",artifact_ref:"s3://fixture/tool2",capabilities:[],permissions:[]});
  await registry.beginScan(tenant,manifest,second);
  expect(await registry.completeScan(tenant,manifest,second,secondScan,clean)).toMatchObject({status:"review_pending"});
  await expect(ops.review(manifest,second,"stf_review",{scanReportId:secondScan,decision:"approved",reason:"Skip seller"},async()=>{})).rejects.toMatchObject({status:409});
  const seller=new SellerGovernanceRepository(pool),current=await seller.review(tenant,"tool_manifest",manifest);
  await seller.resubmit(tenant,"tool_manifest",manifest,"usr_seller","Corrected package",current.etag,async()=>{});
  expect(await ops.review(manifest,second,"stf_review",{scanReportId:secondScan,decision:"approved",reason:"Resubmitted clean version"},async()=>{})).toMatchObject({status:"published"});
 });
 it("refuses migration rollback while reviewer history or requested changes remain",async()=>{
  await scoped(tenant,c=>event(c));
  await expect(applyMarketplaceMigrations(admin,{direction:"down",steps:1})).rejects.toThrow("requires preserved history");
  expect((await admin.query("SELECT count(*)::int AS count FROM marketplace_governance_events")).rows[0].count).toBe(1);
  expect((await admin.query("SELECT tag FROM marketplace_migrations WHERE tag='0008_marketplace_governance'")).rows).toHaveLength(1);
 });
 it("increments revision even when an update repeats its timestamp or attempts to set revision",async()=>{
  await scoped(tenant,async client=>{
   await client.query("UPDATE listings SET status='needs_changes',governance_revision=100,updated_at='2026-10-05T00:00:00Z' WHERE id=$1",[listing]);
   expect((await client.query("SELECT governance_revision::text FROM listings WHERE id=$1",[listing])).rows).toEqual([{governance_revision:"1"}]);
   await client.query("UPDATE listings SET name='Corrected workflow',updated_at='2026-10-05T00:00:00Z' WHERE id=$1",[listing]);
   expect((await client.query("SELECT governance_revision::text FROM listings WHERE id=$1",[listing])).rows).toEqual([{governance_revision:"2"}]);
  });
 });
});
