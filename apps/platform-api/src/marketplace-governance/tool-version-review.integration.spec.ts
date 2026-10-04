import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { OsvPackageScanProvider } from "@alterx/adapters";
import { RegistryService } from "../registry/registry.service";
import { PublisherRepository } from "../publisher/publisher.repository";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMarketplaceMigrations } from "../db/marketplace-migrator";
import { AuditEventsClient } from "../engine";
import { RbacModule } from "../rbac";
import { StaffRepository } from "../staff/staff.repository";
import { RegistryRepository } from "../registry/registry.repository";
import type { PackageScanReport } from "../registry/package-scan";
import { MarketplaceGovernanceModule } from "./marketplace-governance.module";
import { MarketplaceGovernanceRepository } from "./marketplace-governance.repository";
import { ToolVersionReviewRepository } from "./tool-version-review.repository";

const databaseUrl = process.env.MARKETPLACE_DATABASE_URL;
const tenant = `ten_${randomUUID()}`, otherTenant = `ten_${randomUUID()}`;
const clean = (): PackageScanReport => ({ verdict:"clean",findings:[],scannerVersion:"native-fixture",durationMs:1,scannedAt:new Date().toISOString() });
const queueUrl = "/api/v1/admin/marketplace/governance/tools/review-queue";

describe.skipIf(!databaseUrl)("first-version staff review: ordinary PostgreSQL and public HTTP", () => {
  let admin: pg.Client, pool: pg.Pool, operationsPool: pg.Pool, registry: RegistryRepository, reviews: ToolVersionReviewRepository;
  let schema: string, role: string, app: NestFastifyApplication;
  const records: Record<string, unknown>[] = [];
  let auditUnavailable = false;
  beforeAll(async () => {
    schema=`review_${randomUUID().replaceAll("-","_")}`; role=`review_role_${randomUUID().replaceAll("-","_")}`;
    admin=new pg.Client({connectionString:databaseUrl}); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}",public`);
    await applyMarketplaceMigrations(admin);
    // The real staff resolver reads this exact production table; JIT grants are not used by registry review.
    await admin.query(readFileSync("apps/platform-api/src/db/migrations/0010_staff_plane.sql","utf8").split("--> statement-breakpoint")[0]!);
    for (const [id,identity,roles] of [["stf_review","auth0|review",["staff_security"]],["stf_support","auth0|support",["staff_support"]],["stf_disabled","auth0|disabled",["staff_admin"]]] as const) {
      await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles,deactivated_at) VALUES($1,$2,$3,$4,$5)",[id,identity,`${id}@example.test`,roles,id==="stf_disabled"?new Date():null]);
    }
    const password=randomUUID(); await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(7210031); GRANT USAGE ON SCHEMA public TO "${role}"; END $$`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const tenantUrl=new URL(databaseUrl!); tenantUrl.username=role; tenantUrl.password=password; tenantUrl.searchParams.set("options",`-c search_path=${schema},public`);
    pool=new pg.Pool({connectionString:tenantUrl.href}); const opsUrl=new URL(databaseUrl!); opsUrl.searchParams.set("options",`-c search_path=${schema},public`);
    operationsPool=new pg.Pool({connectionString:opsUrl.href}); registry=new RegistryRepository(pool); reviews=new ToolVersionReviewRepository(operationsPool);
    vi.stubEnv("AUTH0_STAFF_DOMAIN","staff.example.test");
    vi.stubEnv("MARKETPLACE_SEARCH_CURSOR_SECRET","native-review-cursor-secret");
    for (const key of ["ENGINE_BASE_URL","ADS_CORE_BASE_URL","COST_LEDGER_BASE_URL","AUDIT_SERVICE_BASE_URL","ENGINE_M2M_TOKEN_URL"]) vi.stubEnv(key,"http://127.0.0.1:1");
    for (const key of ["EVAL_FACADE_TOKEN_REF","DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF","AUDIT_QUERY_SERVICE_TOKEN_REF","ENGINE_M2M_AUDIENCE","ENGINE_M2M_CLIENT_ID","ENGINE_M2M_CLIENT_SECRET_REF","CONNECTION_REGISTRY_SERVICE_TOKEN_REF"]) vi.stubEnv(key,"native-unused-reference");
    const realFetch=globalThis.fetch;
    // Identity-provider edge only. StaffService, staff lookup, middleware and RBAC stay real.
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input)!=="https://staff.example.test/userinfo") return realFetch(input,init);
      const token=new Headers(init?.headers).get("authorization");
      const identity=token==="Bearer review-token"?"review":token==="Bearer support-token"?"support":token==="Bearer disabled-token"?"disabled":undefined;
      return identity ? Response.json({sub:`auth0|${identity}`,email:`${identity}@example.test`}) : new Response("",{status:401});
    });
    const module=await Test.createTestingModule({imports:[RbacModule,MarketplaceGovernanceModule]})
      .overrideProvider(StaffRepository).useValue(new StaffRepository(operationsPool))
      .overrideProvider(ToolVersionReviewRepository).useValue(reviews)
      .overrideProvider(MarketplaceGovernanceRepository).useValue(new MarketplaceGovernanceRepository(operationsPool))
      .overrideProvider(AuditEventsClient).useValue({record:async (input:Record<string,unknown>) => { if(auditUnavailable) throw new Error("Audit edge unavailable"); records.push(input); return {entry_hash:"a".repeat(64)}; }})
      .compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init(); await app.getHttpAdapter().getInstance().ready();
  },60000);
  beforeEach(() => { records.length=0; auditUnavailable=false; });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); await app?.close(); await pool?.end(); await operationsPool?.end();
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(7210031); REVOKE USAGE ON SCHEMA public FROM "${role}"; END $$`); await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end();}
  });
  async function fixture() {
    const manifest=await registry.createManifest(tenant,`tlm_${randomUUID()}`,{name:`Native package ${randomUUID()}`,ecosystem:"npm",trust_level:"community_reviewed"});
    const version=await nextVersion(manifest.id,"1.0.0"); return {manifest,version};
  }
  const nextVersion=(manifestId:string,number:string)=>registry.createVersion(tenant,`tlv_${randomUUID()}`,manifestId,{version:number,artifact_ref:`s3://fixture/${number}.tgz`,capabilities:[],permissions:[]});
  async function scan(manifestId:string,versionId:string,result=clean()) {
    await registry.beginScan(tenant,manifestId,versionId); return registry.completeScan(tenant,manifestId,versionId,`scn_${randomUUID()}`,result);
  }
  const request=(url=queueUrl,token="review-token",body?:Record<string,unknown>)=>app.inject({method:body===undefined?"GET":"POST",url,headers:{cookie:token=== "tenant-token"?"alter_access=tenant-token":`alter_staff_access=${token}`},...(body===undefined?{}:{payload:body})});
  const reviewUrl=(manifestId:string,versionId:string)=>`/api/v1/admin/marketplace/governance/tools/${manifestId}/versions/${versionId}/review`;
  const decision=(scanReportId:string,reason="Inspected package and dependency scan")=>({scanReportId,decision:"approved" as const,reason});

  it("uses an ordinary non-owner, non-bypass role and keeps first clean version private until the real staff decision", async () => {
    const roleInfo=await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"); expect(roleInfo.rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    expect((await pool.query("SELECT * FROM tool_manifests")).rowCount).toBe(0);
    const {manifest,version}=await fixture(),waiting=await scan(manifest.id,version.id); expect(waiting.status).toBe("review_pending");
    expect(await registry.get(otherTenant,manifest.id)).toBeUndefined();
    const genericApprove=await request(`/api/v1/admin/marketplace/governance/tool_manifest/${manifest.id}/actions/apply`,"review-token",{action:"approve",reason:"Generic decision"});
    expect(genericApprove.statusCode).toBe(400);
    for(const token of ["invalid-token","tenant-token","support-token","disabled-token"]) expect((await request(queueUrl,token)).statusCode).toBe(403);
    const queue=await request(); expect(queue.statusCode).toBe(200); expect(queue.json()).toEqual(expect.arrayContaining([expect.objectContaining({manifestId:manifest.id,version:expect.objectContaining({id:version.id,scanReportId:waiting.scanReportId}),scan:expect.objectContaining({id:waiting.scanReportId,verdict:"clean",findings:[]})})]));
    const approved=await request(reviewUrl(manifest.id,version.id),"review-token",decision(waiting.scanReportId!)); expect(approved.statusCode).toBe(201); expect(approved.json()).toMatchObject({status:"published",review:{reviewedBy:"stf_review",scanReportId:waiting.scanReportId}});
    expect(await registry.get(otherTenant,manifest.id)).toBeDefined(); expect(records).toHaveLength(1); expect(records[0]).toMatchObject({actor_ref:"stf_review",tenant_id:tenant,action:"registry.first-version.approved",target_ref:version.id});
    expect(JSON.parse(String(records[0]!.context_json))).toEqual({scope:["registry:first-version-review",`scan:${waiting.scanReportId}`]});
  });
  it("rejects role/actor spoofing and unknown fields without recording a decision",async()=>{
    const {manifest,version}=await fixture(),waiting=await scan(manifest.id,version.id),url=reviewUrl(manifest.id,version.id);
    expect((await request(url,"support-token",decision(waiting.scanReportId!))).statusCode).toBe(403);
    for(const body of [{...decision(waiting.scanReportId!),staffUserId:"stf_admin"}, {...decision(waiting.scanReportId!),reason:" "}, {...decision(waiting.scanReportId!),scanReportId:"wrong"}]) expect((await request(url,"review-token",body)).statusCode).toBe(400);
    expect((await registry.getVersion(tenant,manifest.id,version.id))!.status).toBe("review_pending"); expect(records).toHaveLength(0);
  });
  it("serializes identical staff retries and emits one audit; changed decision remains a conflict",async()=>{
    const {manifest,version}=await fixture(),waiting=await scan(manifest.id,version.id),url=reviewUrl(manifest.id,version.id),body=decision(waiting.scanReportId!);
    const responses=await Promise.all([request(url,"review-token",body),request(url,"review-token",body)]); expect(responses.map(r=>r.statusCode)).toEqual([201,201]); expect(records).toHaveLength(1);
    expect((await request(url,"review-token",{...body,decision:"rejected"})).statusCode).toBe(409); expect(records).toHaveLength(1);
  });
  it("refuses a staff decision on a scan replaced by a new scan",async()=>{
    const {manifest,version}=await fixture(),first=await scan(manifest.id,version.id),second=await scan(manifest.id,version.id);
    expect(first.scanReportId).not.toBe(second.scanReportId);
    expect((await request(reviewUrl(manifest.id,version.id),"review-token",decision(first.scanReportId!))).statusCode).toBe(409);
    expect((await registry.getVersion(tenant,manifest.id,version.id))!.review).toBeNull(); expect(records).toHaveLength(0);
  });
  it("rolls publication and attribution back when audit delivery fails",async()=>{
    const {manifest,version}=await fixture(),waiting=await scan(manifest.id,version.id); auditUnavailable=true;
    expect((await request(reviewUrl(manifest.id,version.id),"review-token",decision(waiting.scanReportId!))).statusCode).toBe(500);
    expect(await registry.getVersion(tenant,manifest.id,version.id)).toMatchObject({status:"review_pending",review:null}); expect(await registry.get(otherTenant,manifest.id)).toBeUndefined();
    auditUnavailable=false; expect((await request(reviewUrl(manifest.id,version.id),"review-token",decision(waiting.scanReportId!))).statusCode).toBe(201);
  });
  it("publishes later clean versions after first review, but every finding severity stays unpublished",async()=>{
    const {manifest,version}=await fixture(),waiting=await scan(manifest.id,version.id);
    await reviews.review(manifest.id,version.id,"stf_review",decision(waiting.scanReportId!),async()=>undefined);
    const later=await nextVersion(manifest.id,"2.0.0"); expect((await scan(manifest.id,later.id)).status).toBe("published");
    for(const [i,severity] of (["info","low","medium","high","critical"] as const).entries()) {
      const item=await nextVersion(manifest.id,`3.0.${i}`),result=await scan(manifest.id,item.id,{...clean(),verdict:"findings",findings:[{locator:"fixture@1.0.0",severity,detail:"Advisory",rule:`ADVISORY-${i}`}]});
      expect(result.status).toBe("scan_failed"); expect((await registry.latestReport(tenant,item.id))!.findings[0]!.severity).toBe(severity);
    }
  });
  it("admits one concurrent scan and never republishes after revocation or a staff takedown",async()=>{
    const {manifest,version}=await fixture(); const starts=await Promise.allSettled([registry.beginScan(tenant,manifest.id,version.id),registry.beginScan(tenant,manifest.id,version.id)]);
    expect(starts.filter(x=>x.status==="fulfilled")).toHaveLength(1); expect(starts.filter(x=>x.status==="rejected")).toHaveLength(1);
    await registry.revoke(tenant,`rvk_${randomUUID()}`,manifest.id,version.id,"Owner revoked","usr_fixture"); expect((await registry.completeScan(tenant,manifest.id,version.id,`scn_${randomUUID()}`,clean())).status).toBe("revoked");
    const other=await fixture(); await registry.beginScan(tenant,other.manifest.id,other.version.id); expect((await request(`/api/v1/admin/marketplace/governance/tool_manifest/${other.manifest.id}/actions/apply`,"review-token",{action:"takedown",reason:"Staff withdrew package"})).statusCode).toBe(201);
    expect((await registry.completeScan(tenant,other.manifest.id,other.version.id,`scn_${randomUUID()}`,clean())).status).toBe("revoked"); expect(await registry.get(otherTenant,other.manifest.id)).toBeUndefined();
  });
  it.runIf(Boolean(process.env["OSV_SCANNER_EXECUTABLE"]))("runs actual OSV through RegistryService before an exact-scan public staff decision",async()=>{
    const {manifest,version}=await fixture();
    const bytes=Buffer.from(JSON.stringify({lockfileVersion:3,packages:{"":{dependencies:{"left-pad":"1.3.0"}},"node_modules/left-pad":{version:"1.3.0"}}}));
    const scanner=new OsvPackageScanProvider({read:async request=>{expect(request).toMatchObject({tenantId:tenant,manifestId:manifest.id,manifestVersion:version.version,artifactRef:version.artifactRef});return{name:"package-lock.json",bytes};}},process.env["OSV_SCANNER_EXECUTABLE"]!);
    const service=new RegistryService(registry,new PublisherRepository(pool),scanner);
    const waiting=await service.scan(tenant,manifest.id,version.id); expect(waiting.status).toBe("review_pending");
    const report=await service.report(tenant,manifest.id,version.id); expect(report).toMatchObject({id:waiting.scanReportId,verdict:"clean",findings:[]}); expect(report.scannerVersion).toMatch(/^osv-scanner 2.6.0 sha256:/);
    expect((await request(reviewUrl(manifest.id,version.id),"review-token",decision(report.id))).statusCode).toBe(201);
    expect((await registry.getVersion(tenant,manifest.id,version.id))!.status).toBe("published");
  },180000);
  it("binds review pointers to the version's own report and permits report/version/manifest erasure in one transaction",async()=>{
    const a=await fixture(),b=await fixture(),sa=await scan(a.manifest.id,a.version.id),sb=await scan(b.manifest.id,b.version.id);
    await expect(admin.query("UPDATE tool_versions SET latest_scan_report_id=$2 WHERE id=$1",[a.version.id,sb.scanReportId])).rejects.toMatchObject({code:"23503"});
    const c=await pool.connect(); try {await c.query("BEGIN"); await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]); await c.query("DELETE FROM tool_scan_reports WHERE id=$1",[sa.scanReportId]); await c.query("DELETE FROM tool_versions WHERE id=$1",[a.version.id]); await c.query("DELETE FROM tool_manifests WHERE id=$1",[a.manifest.id]); await c.query("COMMIT");} catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
    expect(await registry.get(tenant,a.manifest.id)).toBeUndefined();
  });
});
