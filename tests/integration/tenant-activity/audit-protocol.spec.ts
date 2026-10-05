import {createHash} from "node:crypto";
import {Test} from "@nestjs/testing";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {createMockAuditStoreProvider,AUDIT_STORE_PROVIDER,type SecretsProvider,type AuditEventHandler} from "@alterx/shared-clients";
import type {IdentityTenantGatewayRequest} from "@alterx/auth";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {AuditService} from "../../../apps/audit-service/src/audit/audit.service";
import {AuditQueryController,AUDIT_QUERY_SERVICE_TOKEN_HASH} from "../../../apps/audit-service/src/audit/audit-query.controller";
import {AuditEventsClient} from "../../../apps/platform-api/src/engine/audit-events-client";
import {engineConfigFromEnvironment} from "../../../apps/platform-api/src/engine/config";
import {AdminAuditService} from "../../../apps/platform-api/src/admin-audit";
import {AdminTenantActivityService} from "../../../apps/platform-api/src/admin-tenants/admin-tenant-activity.service";
import type {AdminTenantsRepository} from "../../../apps/platform-api/src/admin-tenants/admin-tenants.repository";
import type {TenantActivityClient} from "../../../apps/platform-api/src/engine/tenant-activity-client";
import {TenantActivityController} from "../../../apps/orchestration-service/src/tenant-activity/tenant-activity.controller";
import type {TenantActivityService} from "../../../apps/orchestration-service/src/tenant-activity/tenant-activity.service";
const tenant="018f47a5-7b2c-7d10-8f11-123456789abc",window={tenant_id:tenant,start_at:"2026-09-05T00:00:00.000Z",end_at:"2026-10-05T00:00:00.000Z"};
const data={...window,workflow_count:0,run_count:0,workflows:[],runs:[]};
describe("tenant activity actual central audit protocol",()=>{
 let app:NestFastifyApplication,client:AuditEventsClient,badClient:AuditEventsClient;
 beforeAll(async()=>{
  const store=createMockAuditStoreProvider(),audit=new AuditService(store),token="tenant-activity-native-audit-token";
  const module=await Test.createTestingModule({controllers:[AuditQueryController],providers:[{provide:AuditService,useValue:audit},{provide:AUDIT_STORE_PROVIDER,useValue:store},{provide:AUDIT_QUERY_SERVICE_TOKEN_HASH,useValue:createHash("sha256").update(token).digest("hex")}]}).compile();
  app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.listen(0,"127.0.0.1");
  const config=engineConfigFromEnvironment({ENGINE_BASE_URL:"http://unused.test",ADS_CORE_BASE_URL:"http://unused.test",COST_LEDGER_BASE_URL:"http://unused.test",EVAL_FACADE_TOKEN_REF:"unused",DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF:"unused",AUDIT_SERVICE_BASE_URL:await app.getUrl(),AUDIT_QUERY_SERVICE_TOKEN_REF:"native/audit",ENGINE_M2M_TOKEN_URL:"http://unused.test",ENGINE_M2M_AUDIENCE:"unused",ENGINE_M2M_CLIENT_ID:"unused",ENGINE_M2M_CLIENT_SECRET_REF:"unused"});
  client=new AuditEventsClient(config,{getSecret:async()=>token} as SecretsProvider);badClient=new AuditEventsClient(config,{getSecret:async()=>"invalid-test-token"} as SecretsProvider);
 });
 afterAll(async()=>{await app?.close();});
 const repository={members:async()=>({count:0,members:[]})} as unknown as AdminTenantsRepository;
 const activity={activity:async()=>data,spend:async()=>({...window,currencies:[]})} as unknown as TenantActivityClient;
 it("accepts attributed staff and service read payloads through actual HTTP validation",async()=>{
  const service=new AdminTenantActivityService(repository,activity,new AdminAuditService(client),()=>new Date(window.end_at));
  expect(await service.read(tenant,"stf_actual")).toMatchObject({...window,members:{count:0,members:[]}});
  const controller=new TenantActivityController({activity:async()=>data} as unknown as TenantActivityService,{recordEvent:input=>client.record(input)} as AuditEventHandler);
  expect(await controller.read({actorContext:{actor_type:"service",tenant_id:"platform-api"}} as IdentityTenantGatewayRequest,window)).toEqual(data);
  const events=await client.query({tenantId:tenant,action:"tenant.activity.read"});expect(events.events).toHaveLength(2);
  expect(events.events).toContainEqual(expect.objectContaining({actor_type:"admin",actor_ref:"stf_actual",context_json:JSON.stringify({scope:"tenant:read"})}));
  expect(events.events).toContainEqual(expect.objectContaining({actor_type:"service",actor_ref:"service:platform-api",context_json:JSON.stringify({scope:"tenant_asserted_by_service"})}));
 });
 it("does not return a successful staff or service read without an audit acknowledgement",async()=>{
  const service=new AdminTenantActivityService(repository,activity,new AdminAuditService(badClient),()=>new Date(window.end_at));
  await expect(service.read(tenant,"stf_actual")).rejects.toThrow();
  const controller=new TenantActivityController({activity:async()=>data} as unknown as TenantActivityService,{recordEvent:input=>badClient.record(input)} as AuditEventHandler);
  await expect(controller.read({actorContext:{actor_type:"service",tenant_id:"platform-api"}} as IdentityTenantGatewayRequest,window)).rejects.toThrow();
 });
});
