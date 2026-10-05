import "reflect-metadata";
import {createHash,generateKeyPairSync,randomBytes,sign} from "node:crypto";
// eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- loopback JWKS issuer for real audit gRPC authentication.
import {createServer,type Server} from "node:http";
import {createServer as reservePort} from "node:net";
import {createRequire} from "node:module";
import {readdirSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {v7 as uuidv7} from "uuid";
import pg from "pg";
import {Test} from "@nestjs/testing";
import {APP_FILTER} from "@nestjs/core";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {AuditServiceClient,PostgresAuditStoreProvider,PostgresOrchestrationStoreProvider,startAuditGrpcTransport} from "@alterx/adapters";
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from "@testcontainers/postgresql";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {RbacModule} from "../rbac";
import {StaffService} from "../staff/staff.service";
import {StaffRepository} from "../staff/staff.repository";
import {StaffAuthMiddleware} from "../staff/staff.middleware";
import {AdminAuditService} from "../admin-audit";
import {EngineExceptionFilter} from "../engine/engine-exception.filter";
import {DeploymentAdminClient} from "../engine/deployment-admin-client";
import type {EngineConfig} from "../engine/config";
import {AdminDeploymentController} from "./admin-deployment.controller";
import {AdminDeploymentService} from "./admin-deployment.service";
const requireBuilt=createRequire(resolve("package.json"));
const {DeploymentAdminController:EngineController,DEPLOYMENT_ADMIN_TOKEN_HASH}=requireBuilt(resolve("dist/apps/orchestration-service/deployment-admin/deployment-admin.controller.js"));
const {DeploymentAdminService:EngineService}=requireBuilt(resolve("dist/apps/orchestration-service/deployment-admin/deployment-admin.service.js"));
const {AppModule:AuditAppModule}=requireBuilt(resolve("dist/apps/audit-service/app.module.js"));
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("deployment current staff HTTP, ordinary tenant PostgreSQL and native acknowledged audit gRPC",()=>{
 let admin:pg.Client,pool:pg.Pool,schema:string,role:string,app:NestFastifyApplication,engine:NestFastifyApplication,auditApp:NestFastifyApplication,jwks:Server;
 let engineContainer:StartedPostgreSqlContainer,auditContainer:StartedPostgreSqlContainer,engineAdmin:PostgresOrchestrationStoreProvider,engineStore:PostgresOrchestrationStoreProvider,auditStore:PostgresAuditStoreProvider,auditDb:pg.Client;
 let auditClient:AuditServiceClient,badAudit=false,badEngine=false,readAuditUnavailable=false,engineBase:string,config:EngineConfig,pauseAudit:(()=>Promise<void>)|undefined;
 const tenant=uuidv7(),other=uuidv7(),missing=uuidv7(),workspace=uuidv7(),project=`prj_${uuidv7()}`,deployment=`dep_${uuidv7()}`,foreign=`dep_${uuidv7()}`,credential=randomBytes(24).toString("hex");
 const headers={cookie:"alter_staff_access=valid-deployment-staff"},path="/api/v1/admin/deployments";
 beforeAll(async()=>{
  schema="deploy_"+uuidv7().replaceAll("-","_");role="deploy_"+uuidv7().replaceAll("-","_");admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
  const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const sql of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(sql.trim())await admin.query(sql);
  await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Deployment tenant','active'),($2,'Other tenant','active')",[tenant,other]);await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_deployment','auth0|deployment','admin@example.test',ARRAY['staff_admin'])");
  const password=randomBytes(24).toString("hex");await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const dbUrl=new URL(database!);dbUrl.username=role;dbUrl.password=password;dbUrl.searchParams.set("options",`-c search_path=${schema},public`);pool=new pg.Pool({connectionString:dbUrl.href});
  [engineContainer,auditContainer]=await Promise.all([new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start(),new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("audit_db").withPassword(randomBytes(24).toString("hex")).start()]);
  const migrationsFolder=resolve("apps/orchestration-service/drizzle");engineAdmin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:engineContainer.getConnectionUri(),migrationsFolder});await engineAdmin.migrate();
  const enginePassword=randomBytes(24).toString("hex");await engineAdmin.withTenant(tenant,async tx=>{await tx.query(`CREATE ROLE deployment_engine LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${enginePassword}'`);await tx.query("GRANT USAGE ON SCHEMA public TO deployment_engine");await tx.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO deployment_engine");});
  const engineUrl=new URL(engineContainer.getConnectionUri());engineUrl.username="deployment_engine";engineUrl.password=enginePassword;engineStore=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:engineUrl.href,migrationsFolder});
  for(const [scope,id,parent] of [[tenant,deployment,project],[other,foreign,`prj_${uuidv7()}`]])await engineStore.withTenant(scope!,async tx=>{
   const run=`run_${uuidv7()}`,artifact=`art_${uuidv7()}`;await tx.query("INSERT INTO projects(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Recorded native project')",[parent,scope,workspace]);await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,project_id) VALUES($1,$2,$3,'project',$4)",[run,scope,workspace,parent]);await tx.query("INSERT INTO artifacts(id,tenant_id,run_id,storage_reference,content_type,size_bytes) VALUES($1,$2,$3,'s3://fixture','text/plain',1)",[artifact,scope,run]);await tx.query("INSERT INTO deployments(id,tenant_id,project_id,status,artifact_id,destination_reference) VALUES($1,$2,$3,'active',$4,'s3://fixture/native')",[id,scope,parent,artifact]);
  });
  auditDb=new pg.Client({connectionString:auditContainer.getConnectionUri()});await auditDb.connect();const auditPassword=randomBytes(24).toString("hex");await auditDb.query(`CREATE ROLE audit_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${auditPassword}'`);await auditDb.query("ALTER DATABASE audit_db OWNER TO audit_service");await auditDb.query("GRANT CREATE,USAGE ON SCHEMA public TO audit_service");const auditUrl=new URL(auditContainer.getConnectionUri());auditUrl.username="audit_service";auditUrl.password=auditPassword;auditStore=new PostgresAuditStoreProvider({authentication:"static",connectionString:auditUrl.href,migrationsFolder:resolve("apps/audit-service/drizzle")});await auditStore.migrate();
  const key=generateKeyPairSync("rsa",{modulusLength:2048}),kid="deployment-native";jwks=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({keys:[{...key.publicKey.export({format:"jwk"}),kid,alg:"RS256",use:"sig"}]}));});await new Promise<void>(resolve=>jwks.listen(0,"127.0.0.1",resolve));const address=jwks.address();if(!address||typeof address==="string")throw new Error("JWKS address unavailable");
  for(const [name,value] of Object.entries({AUTH0_DOMAIN:"deployment.audit.test",API_AUDIENCE:"alter-engine",AUTH0_JWKS_URL:`http://127.0.0.1:${address.port}`}))vi.stubEnv(name,value);
  const auditModule=await Test.createTestingModule({imports:[AuditAppModule.register(auditStore)]}).compile();auditApp=auditModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());const reservation=reservePort();await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));const reserved=reservation.address();if(!reserved||typeof reserved==="string")throw new Error("Audit address unavailable");await new Promise<void>(resolve=>reservation.close(()=>resolve()));const auditAddress=`127.0.0.1:${reserved.port}`;
  await startAuditGrpcTransport(auditApp,{bindAddress:auditAddress,protoPath:resolve("packages/contracts/proto/alter/audit/v1/audit.proto")});await auditApp.listen(0,"127.0.0.1");
  const token=()=>{const now=Math.floor(Date.now()/1000),value=[{alg:"RS256",kid},{iss:"https://deployment.audit.test/",aud:"alter-engine",iat:now,exp:now+60,tenant_id:`ten_${tenant}`,"https://alter.dev/claims/actor_type":"service"}].map(value=>Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");return `${value}.${sign("RSA-SHA256",Buffer.from(value),key.privateKey).toString("base64url")}`;};
  auditClient=new AuditServiceClient({address:auditAddress,protoPath:resolve("packages/contracts/proto/alter/audit/v1/audit.proto"),accessTokenProvider:{getAccessToken:async()=>badAudit?"invalid-audit-credential":token()}});
  const engineModule=await Test.createTestingModule({controllers:[EngineController],providers:[{provide:EngineService,useValue:new EngineService(engineStore,{recordEvent:async(input:Parameters<AuditServiceClient["recordEvent"]>[0])=>{if(pauseAudit)await pauseAudit();return auditClient.recordEvent(input);}})},{provide:DEPLOYMENT_ADMIN_TOKEN_HASH,useValue:createHash("sha256").update(credential).digest("hex")}]}).compile();engine=engineModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await engine.listen(0,"127.0.0.1");engineBase=await engine.getUrl();
  config={baseUrl:engineBase,adsCoreBaseUrl:"http://unused.test",costLedgerBaseUrl:"http://unused.test",evalFacadeTokenRef:"unused",deploymentAdminServiceTokenRef:"native/deployment",auditServiceBaseUrl:"http://unused.test",auditQueryServiceTokenRef:"unused",m2mTokenUrl:"http://unused.test",m2mAudience:"unused",m2mClientId:"unused",m2mClientSecretRef:"unused",requestTimeoutMs:3000,planningTimeoutMs:120000};
  const client=new DeploymentAdminClient(config,async()=>badEngine?"invalid-deployment-credential":credential),audit=new AdminAuditService({record:async(input:Parameters<AuditServiceClient["recordEvent"]>[0])=>{if(readAuditUnavailable)throw new Error("Read audit unavailable");return auditClient.recordEvent(input);}} as never);
  const realFetch=globalThis.fetch;vi.stubEnv("AUTH0_STAFF_DOMAIN","deployment.staff.test");vi.stubGlobal("fetch",async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{if(String(input)!=="https://deployment.staff.test/userinfo")return realFetch(input,init);return new Headers(init?.headers).get("authorization")==="Bearer valid-deployment-staff"?Response.json({sub:"auth0|deployment",email:"admin@example.test"}):new Response("",{status:401});});
  const staff=new StaffService(new StaffRepository(pool),audit),middleware=new StaffAuthMiddleware(staff),module=await Test.createTestingModule({imports:[RbacModule],controllers:[AdminDeploymentController],providers:[{provide:AdminDeploymentService,useValue:new AdminDeploymentService(client,audit,pool)},{provide:APP_FILTER,useClass:EngineExceptionFilter}]}).compile();app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());app.getHttpAdapter().getInstance().addHook("preHandler",async(request,reply)=>middleware.use(request as unknown as Parameters<StaffAuthMiddleware["use"]>[0],reply,()=>{}));await app.init();await app.getHttpAdapter().getInstance().ready();
 },120000);
 beforeEach(async()=>{badAudit=false;badEngine=false;readAuditUnavailable=false;pauseAudit=undefined;await admin.query("UPDATE staff_users SET roles=ARRAY['staff_admin'],deactivated_at=NULL WHERE id='stf_deployment'");});
 afterAll(async()=>{await app?.close();await engine?.close();await auditApp?.close();await engineStore?.close();await engineAdmin?.close();await auditDb?.end();await pool?.end();if(jwks)await new Promise<void>(resolve=>jwks.close(()=>resolve()));await engineContainer?.stop();await auditContainer?.stop();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}vi.unstubAllGlobals();vi.unstubAllEnvs();},60000);
 const list=(id=tenant,auth:Record<string,string>=headers)=>app.inject({method:"GET",url:`${path}?tenant_id=${id}`,headers:auth});
 const apply=(etag:string|undefined,body:unknown={tenant_id:tenant,deployment_id:deployment,action:"suspend",reason:"Recorded native staff action"},id=deployment)=>app.inject({method:"POST",url:`${path}/${id}/actions/apply`,headers:{...headers,...(etag?{"if-match":etag}:{})},payload:body as object});
 it("lists actual named-tenant records over authenticated Engine TCP and records staff read attribution",async()=>{
  expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);const response=await list();expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({tenant_id:tenant,total:1,items:[{id:deployment,project_id:project,project_name:"Recorded native project",status:"active",etag:`"${deployment}:rev-1"`}]});
  expect((await list(other)).json().items.map((row:{id:string})=>row.id)).toEqual([foreign]);expect((await list(missing)).statusCode).toBe(404);
  const events=await auditDb.query("SELECT actor_ref,action,tenant_id::text FROM audit_events WHERE action='deployment.list'");expect(events.rows).toContainEqual({actor_ref:"stf_deployment",action:"deployment.list",tenant_id:tenant});
 });
 it("requires current staff admin and rejects malformed requests and invalid internal credentials",async()=>{
  for(const auth of [{},{cookie:"alter_staff_access=expired"}])expect((await list(tenant,auth)).statusCode).toBe(403);
  for(const roles of [["staff_support"],["staff_security"],["staff_billing_ops"]]){await admin.query("UPDATE staff_users SET roles=$1 WHERE id='stf_deployment'",[roles]);expect((await list()).statusCode).toBe(403);expect((await apply('"current"')).statusCode).toBe(403);}
  await admin.query("UPDATE staff_users SET roles=ARRAY['staff_admin'],deactivated_at=now() WHERE id='stf_deployment'");expect((await list()).statusCode).toBe(403);await admin.query("UPDATE staff_users SET deactivated_at=NULL WHERE id='stf_deployment'");
  expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(400);expect((await app.inject({method:"GET",url:`${path}?tenant_id=${tenant}&extra=1`,headers})).statusCode).toBe(400);
  expect((await engine.inject({method:"GET",url:`/internal/admin/deployments?tenant_id=${tenant}`})).statusCode).toBe(401);badEngine=true;expect((await list()).statusCode).toBe(502);badEngine=false;
  readAuditUnavailable=true;expect((await list()).statusCode).toBe(500);
 });
 it("requires exact revision and human reason, derives staff actor server-side and persists actual audit",async()=>{
  const before=(await list()).json().items[0];expect((await apply(undefined)).statusCode).toBe(428);expect((await apply('"stale"')).statusCode).toBe(412);
  for(const body of [{tenant_id:tenant,deployment_id:deployment,action:"suspend",reason:"",staff_user_id:"stf_forged"},{tenant_id:tenant,deployment_id:deployment,action:"suspend",reason:"x".repeat(1001)},{tenant_id:tenant,deployment_id:foreign,action:"suspend",reason:"Mismatch"}])expect((await apply(before.etag,body)).statusCode).toBe(400);
  const reason="文".repeat(1000),response=await apply(before.etag,{tenant_id:tenant,deployment_id:deployment,action:"suspend",reason});expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({status:"suspended",etag:`"${deployment}:rev-2"`});
  const history=await engineStore.withTenant(tenant,tx=>tx.query("SELECT actor_ref,reason FROM deployment_admin_actions WHERE deployment_id=$1",[deployment]));expect(history.rows).toEqual([{actor_ref:"stf_deployment",reason}]);const events=await auditDb.query("SELECT actor_ref,reason_code,context FROM audit_events WHERE action='deployment.suspend'");expect(events.rows).toHaveLength(1);expect(events.rows[0]).toMatchObject({actor_ref:"stf_deployment",reason_code:"staff_deployment_action",context:{scope:expect.stringContaining("history:daa_")}});
 });
 it("rolls back actual deployment state and history when authenticated audit gRPC refuses acknowledgement",async()=>{
  const before=(await list()).json().items[0];badAudit=true;const response=await apply(before.etag,{tenant_id:tenant,deployment_id:deployment,action:"resume",reason:"Native denied audit"});expect(response.statusCode).toBe(500);badAudit=false;
  expect((await list()).json().items[0]).toEqual(before);expect((await engineStore.withTenant(tenant,tx=>tx.query("SELECT action FROM deployment_admin_actions WHERE deployment_id=$1",[deployment]))).rows).toEqual([{action:"suspend"}]);
 });
 it("keeps platform tenant deletion serialized while the Engine write awaits real audit",async()=>{
  const before=(await list()).json().items[0];let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});pauseAudit=()=>{entered();return new Promise<void>(resolve=>{release=resolve;});};const pending=apply(before.etag,{tenant_id:tenant,deployment_id:deployment,action:"resume",reason:"Await acknowledged audit"});await waiting;
  const tx=await pool.connect();try{await tx.query("BEGIN");await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);await tx.query("SET LOCAL lock_timeout='100ms'");await expect(tx.query("UPDATE tenants SET deleted_at=now() WHERE id=$1",[tenant])).rejects.toMatchObject({code:"55P03"});}finally{await tx.query("ROLLBACK");tx.release();release();}
  expect((await pending).statusCode).toBe(201);pauseAudit=undefined;await admin.query("UPDATE tenants SET deleted_at=now() WHERE id=$1",[tenant]);expect((await list()).statusCode).toBe(404);expect((await apply(`"${deployment}:rev-3"`)).statusCode).toBe(404);
 });
});
