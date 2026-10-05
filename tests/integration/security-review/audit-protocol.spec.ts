import {createHash} from "node:crypto";
import {Test} from "@nestjs/testing";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {createMockAuditStoreProvider,AUDIT_STORE_PROVIDER,type SecretsProvider} from "@alterx/shared-clients";
import type {AbuseSignal} from "@alterx/contracts";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {AuditService} from "../../../apps/audit-service/src/audit/audit.service";
import {AuditQueryController,AUDIT_QUERY_SERVICE_TOKEN_HASH} from "../../../apps/audit-service/src/audit/audit-query.controller";
import {AuditEventsClient} from "../../../apps/platform-api/src/engine";
import type {EngineConfig} from "../../../apps/platform-api/src/engine/config";
import {AdminAuditService} from "../../../apps/platform-api/src/admin-audit";
import {AbuseSignalService} from "../../../apps/platform-api/src/abuse/abuse-signal.service";
import type {AbuseSignalRepository} from "../../../apps/platform-api/src/abuse/abuse-signal.repository";

const tenant="018f47a5-7b2c-7d10-8f11-123456789abc",id="abs_018f47a5-7b2c-7d10-8f11-123456789abd",history="asa_018f47a5-7b2c-7d10-8f11-123456789abe";
describe("security review writes with actual central audit HTTP validation",()=>{
 let app:NestFastifyApplication,client:AuditEventsClient,config:EngineConfig;
 beforeAll(async()=>{
  const store=createMockAuditStoreProvider(),audit=new AuditService(store),token="security-review-audit-native-only";
  const module=await Test.createTestingModule({controllers:[AuditQueryController],providers:[{provide:AuditService,useValue:audit},
   {provide:AUDIT_STORE_PROVIDER,useValue:store},{provide:AUDIT_QUERY_SERVICE_TOKEN_HASH,useValue:createHash("sha256").update(token).digest("hex")}]}).compile();
  app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.listen(0,"127.0.0.1");
  config={baseUrl:"http://unused.test",adsCoreBaseUrl:"http://unused.test",costLedgerBaseUrl:"http://unused.test",evalFacadeTokenRef:"unused",
   deploymentAdminServiceTokenRef:"unused",auditServiceBaseUrl:await app.getUrl(),auditQueryServiceTokenRef:"native/audit",m2mTokenUrl:"http://unused.test",
   m2mAudience:"unused",m2mClientId:"unused",m2mClientSecretRef:"unused",requestTimeoutMs:1000,planningTimeoutMs:120000};
  client=new AuditEventsClient(config,{getSecret:async()=>token} as SecretsProvider);
 });
 afterAll(async()=>{await app?.close();});
 const reason="文".repeat(1000);
 const item:AbuseSignal={id,tenant_id:tenant,signal_type:"payment_fraud",source:"native.recorded",score:60,evidence_ref:"evt_actual",observed_at:"2026-10-05T00:00:00Z",status:"open",etag:'"rev-2"',
  assignment:{staff_user_id:"stf_target",staff_email:"reviewer@test.test",active:true,assigned_by:"stf_actor",assigned_at:"2026-10-05T00:00:00Z",reason}};
 it.each(["assign","dismiss"] as const)("acknowledges %s using staff attribution and the immutable full-reason history reference",async action=>{
  const mutate=vi.fn(async(...args:unknown[])=>{
   const write=args.at(-1) as {audit:(value:AbuseSignal,historyId:string)=>Promise<unknown>};
   await write.audit(item,history);return item;
  });
  const repository={assign:mutate,review:mutate} as unknown as AbuseSignalRepository;
  const service=new AbuseSignalService(repository,new AdminAuditService(client));
  const result=action==="assign"?await service.assign(id,"stf_actor",{staff_user_id:"stf_target",reason},'"rev-1"'):
   await service.review(id,"stf_actor",{decision:"dismiss",reason},'"rev-1"');
  expect(result).toEqual(item);expect(mutate.mock.calls[0]).toContain(reason);
  const events=await client.query({tenantId:tenant,action:`abuse.signal.${action}`});
  expect(events.events).toHaveLength(1);expect(events.events[0]).toMatchObject({actor_type:"admin",actor_ref:"stf_actor",target_ref:id,reason_code:action==="assign"?"staff_assignment":"staff_decision"});
  expect(JSON.parse(events.events[0]!.context_json)).toEqual({scope:[action==="assign"?"abuse:assign":"abuse:review",`history:${history}`]});
  expect(item.assignment!.reason).toBe(reason);
 });
 it("does not acknowledge a write when actual audit transport rejects its credential",async()=>{
  const rejected=new AuditEventsClient(config,{getSecret:async()=>"invalid-audit-credential"} as SecretsProvider);
  const repository={assign:async(_id:unknown,_target:unknown,_reason:unknown,_actor:unknown,write:{audit:(value:AbuseSignal,historyId:string)=>Promise<unknown>})=>{await write.audit(item,history);return item;}} as unknown as AbuseSignalRepository;
  await expect(new AbuseSignalService(repository,new AdminAuditService(rejected)).assign(id,"stf_actor",{staff_user_id:"stf_target",reason},'"rev-1"')).rejects.toThrow();
 });
});
