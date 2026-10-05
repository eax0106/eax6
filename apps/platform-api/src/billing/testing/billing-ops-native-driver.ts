import {billingDatabaseFromEnvironment} from "../config";
import {randomUUID} from "node:crypto";
import {readdirSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {v7 as uuidv7} from "uuid";
import pg from "pg";
import {RazorpayBillingProvider} from "@alterx/adapters";
import {AdminAuditService} from "../../admin-audit";
import {BillingPolicyClient} from "../../engine/billing-policy-client";
import {PostgresPlanDefinitionStore} from "../../entitlements/plan-definition-store";
import {PlanDefinitionConfigProvider} from "../../entitlements/plan-definition-config-provider";
import {LocalFileConfigProvider} from "../../entitlements/adapters/local-file/local-file-config-provider";
import {InternalEntitlementProvider} from "../../entitlements/internal-entitlement-provider";
import {PostgresEntitlementStore} from "../../entitlements/entitlement-store";
import {AdminBillingOperationsRepository} from "../admin-billing-operations.repository";
import {AdminBillingOperationsService} from "../admin-billing-operations.service";
import {BillingRepository} from "../billing.repository";
import {BillingPolicyService} from "../billing-policy.service";
export async function createBillingOpsNativeDriver(client?:BillingPolicyClient){
 const database=billingDatabaseFromEnvironment(process.env);if(!database)throw new Error("Native billing database required");
 const schema="ops_"+uuidv7().replaceAll("-","_"),role="ops_"+uuidv7().replaceAll("-","_"),admin=new pg.Client({connectionString:database});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema},public`);
 const dir=resolve("apps/platform-api/src/db/migrations");for(const name of readdirSync(dir).filter(name=>name.endsWith(".sql")).sort())for(const statement of readFileSync(resolve(dir,name),"utf8").split("--> statement-breakpoint"))if(statement.trim())await admin.query(statement);
 const tenant=uuidv7(),other=uuidv7();await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Actual native tenant','active'),($2,'Unrelated tenant','active')",[tenant,other]);await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_native_ops','auth0|native-ops','native@example.test',ARRAY['staff_billing_ops'])");
 const password=randomUUID();await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role},platform_provisioner`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
 const url=new URL(database);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema},public`);const pool=new pg.Pool({connectionString:url.href}),definitions=new PostgresPlanDefinitionStore(pool),config=new PlanDefinitionConfigProvider(new LocalFileConfigProvider(),definitions),entitlements=new InternalEntitlementProvider(new PostgresEntitlementStore(pool),config);
 const commercial={currency:"INR" as const,basePriceMinor:10003,razorpayPlanId:"plan_NativeOps",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2};await definitions.upsert("basic",await config.getEntitlementDefaults("free"),"stf_native_ops",commercial,"Native configuration");
 for(const subject of [tenant,other]){await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[subject]);await admin.query("INSERT INTO billing_profiles(tenant_id,id,provider_id,status,current_plan,subscription_ref,provider_plan_ref,commercial_snapshot) VALUES($1,$2,'razorpay','pending','basic',$3,'plan_NativeOps',$4::jsonb)",[subject,uuidv7(),`sub_${subject.replaceAll("-","")}`,JSON.stringify(commercial)]);await admin.query("INSERT INTO billing_dunning_states(tenant_id,state,current_plan,first_failed_at) VALUES($1,'grace','basic',clock_timestamp())",[subject]);await admin.query("INSERT INTO billing_policy_state(tenant_id,email_verified) VALUES($1,true)",[subject]);await entitlements.createEntitlement(subject,"basic",undefined,{accessState:"grace"});}
 const providerState={status:"pending",paid:true,amount:11804,latestUnpaid:false,latestIssuedOffset:1,wrongScope:false,invoiceCurrency:"INR",paidOffset:1};
 const provider=new RazorpayBillingProvider({keyIdSecretRef:"fixture-id",keySecretSecretRef:"fixture-key"},{getSecret:async()=>"provider-edge-fixture"} as never,new BillingRepository(pool),{request:async request=>{
  const reference=request.path.startsWith("/v1/invoices?")?new URLSearchParams(request.path.split("?")[1]).get("subscription_id")!:decodeURIComponent(request.path.split("/").at(-1)!);const now=Math.floor(Date.now()/1000)+providerState.paidOffset;
  if(request.path.startsWith("/v1/invoices?")){const base={id:"inv_ZNativeOps",subscription_id:reference,status:providerState.paid?"paid":"issued",amount:providerState.amount,currency:providerState.invoiceCurrency,created_at:now,issued_at:now,paid_at:providerState.paid?now:null,short_url:"https://rzp.io/rzp/nativeinvoice"};return {status:200,body:{count:providerState.latestUnpaid?2:1,items:providerState.latestUnpaid?[base,{...base,id:"inv_UnpaidNewer",status:"issued",issued_at:now+providerState.latestIssuedOffset,paid_at:null}]:[base]}};}
  return {status:200,body:{id:providerState.wrongScope?"sub_Unrelated":reference,plan_id:"plan_NativeOps",status:providerState.status,short_url:"https://rzp.io/rzp/native-recovery"}};
 }});
 const auditState:{mode:"ok"|"fail"|"invalid";pause?:()=>Promise<void>;events:Record<string,unknown>[]}={mode:"ok",events:[]};
 const audit=new AdminAuditService({record:async(event:Record<string,unknown>)=>{if(auditState.pause)await auditState.pause();if(auditState.mode==="fail")throw new Error("Native audit unavailable");auditState.events.push(event);return {entry_hash:auditState.mode==="invalid"?"invalid":"a".repeat(64)};}} as never);
 const repository=new AdminBillingOperationsRepository(pool),policy=new BillingPolicyService(pool,config,definitions,client,entitlements),service=new AdminBillingOperationsService(repository,provider,audit,policy,entitlements,definitions);
 const revision=async(subject=tenant)=>{await admin.query("SELECT set_config('app.current_tenant_id',$1,false)",[subject]);const row=(await admin.query("SELECT revision::text FROM billing_dunning_states WHERE tenant_id=$1",[subject])).rows[0];return `"billing-${subject}-${row.revision}"`;};
 return {admin,pool,schema,role,tenant,other,repository,policy,service,definitions,entitlements,providerState,auditState,revision,async close(){policy.onModuleDestroy();await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();}};
}
