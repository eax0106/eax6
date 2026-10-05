import {createHash} from "node:crypto";
import {Test} from "@nestjs/testing";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {createMockAuditStoreProvider,AUDIT_STORE_PROVIDER,type SecretsProvider} from "@alterx/shared-clients";
import type {MarketplaceGovernanceItem} from "@alterx/contracts";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {AuditService} from "../../../apps/audit-service/src/audit/audit.service";
import {AuditQueryController,AUDIT_QUERY_SERVICE_TOKEN_HASH} from "../../../apps/audit-service/src/audit/audit-query.controller";
import {AuditEventsClient} from "../../../apps/platform-api/src/engine";
import type {EngineConfig} from "../../../apps/platform-api/src/engine/config";
import {AdminAuditService} from "../../../apps/platform-api/src/admin-audit";
import {MarketplaceGovernanceService} from "../../../apps/platform-api/src/marketplace-governance/marketplace-governance.service";
import type {MarketplaceGovernanceRepository} from "../../../apps/platform-api/src/marketplace-governance/marketplace-governance.repository";
import {SellerGovernanceController} from "../../../apps/platform-api/src/publisher/seller-governance.controller";
import type {SellerGovernanceRepository} from "../../../apps/platform-api/src/publisher/seller-governance.repository";
const tenant="018f47a5-7b2c-7d10-8f11-123456789abc",id="lst_018f47a5-7b2c-7d10-8f11-123456789abd",history="mge_018f47a5-7b2c-7d10-8f11-123456789abe";
describe("marketplace governance reason history with actual central audit HTTP validation",()=>{
 let app:NestFastifyApplication,client:AuditEventsClient;
 beforeAll(async()=>{
  const store=createMockAuditStoreProvider(),audit=new AuditService(store),token="governance-audit-native-only";
  const module=await Test.createTestingModule({controllers:[AuditQueryController],providers:[{provide:AuditService,useValue:audit},
    {provide:AUDIT_STORE_PROVIDER,useValue:store},{provide:AUDIT_QUERY_SERVICE_TOKEN_HASH,useValue:createHash("sha256").update(token).digest("hex")}]}).compile();
  app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.listen(0,"127.0.0.1");
  const config:EngineConfig={baseUrl:"http://unused.test",adsCoreBaseUrl:"http://unused.test",costLedgerBaseUrl:"http://unused.test",evalFacadeTokenRef:"unused",
    deploymentAdminServiceTokenRef:"unused",auditServiceBaseUrl:await app.getUrl(),auditQueryServiceTokenRef:"native/audit",m2mTokenUrl:"http://unused.test",
    m2mAudience:"unused",m2mClientId:"unused",m2mClientSecretRef:"unused",requestTimeoutMs:1000,planningTimeoutMs:120000};
  client=new AuditEventsClient(config,{getSecret:async()=>token} as SecretsProvider);
 });
 afterAll(async()=>{await app?.close();});
 const reason="文".repeat(1000);
 const item:MarketplaceGovernanceItem={resource_type:"listing",id,tenant_id:tenant,name:"Audited mapping",status:"needs_changes",trust_level:null,updated_at:"2026-10-05T00:00:00Z",etag:'"rev-2"',
   review_notes:[{id:history,actor_type:"staff",actor_ref:"stf_review",action:"needs_changes",previous_status:"human_review",next_status:"needs_changes",reason,occurred_at:"2026-10-05T00:00:00Z"}]};
 it("acknowledges a full Unicode reviewer reason using its immutable local history reference",async()=>{
  const act=vi.fn(async(_type,_id,_input,write)=>{await write.audit(item);return item;});
  const service=new MarketplaceGovernanceService({act} as unknown as MarketplaceGovernanceRepository,new AdminAuditService(client));
  expect(await service.act("listing",id,"stf_review",{action:"needs_changes",reason},'"rev-1"')).toEqual(item);
  const events=await client.query({tenantId:tenant,action:"marketplace.governance.needs_changes"});
  expect(events.events).toHaveLength(1);expect(events.events[0]).toMatchObject({reason_code:"staff_decision",actor_ref:"stf_review"});
  expect(JSON.parse(events.events[0]!.context_json)).toEqual({scope:["marketplace:governance",`history:${history}`]});
  expect(item.review_notes![0]!.reason).toBe(reason);
 });
 it("accepts actual seller correction and resubmit payloads without unsupported audit context keys",async()=>{
  const repository={edit:vi.fn(async(_tenant,_type,_id,_user,_input,_etag,audit)=>{await audit(item);return item;}),
    resubmit:vi.fn(async(_tenant,_type,_id,_user,_reason,_etag,audit)=>{await audit(item);return item;})};
  const controller=new SellerGovernanceController(repository as unknown as SellerGovernanceRepository,client);
  const actor={tenant_id:tenant,user_id:"usr_seller",roles:["owner"],permissions:[],session_id:"native"};
  await controller.edit("listing",id,{name:"Corrected",reason},actor,'"rev-1"');
  await controller.resubmit("listing",id,{reason},actor,'"rev-1"');
  for(const action of ["edit","resubmit"]){const events=await client.query({tenantId:tenant,action:`marketplace.governance.${action}`});expect(events.events).toHaveLength(1);
    expect(JSON.parse(events.events[0]!.context_json)).toEqual({scope:["marketplace:governance",`history:${history}`]});}
 });
});
