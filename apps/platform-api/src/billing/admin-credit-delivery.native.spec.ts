import {createHash,randomBytes} from "node:crypto";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {Test} from "@nestjs/testing";
import {FastifyAdapter,type NestFastifyApplication} from "@nestjs/platform-fastify";
import {PostgresOrchestrationStoreProvider} from "@alterx/adapters";
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from "@testcontainers/postgresql";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {BillingPolicyClient} from "../engine/billing-policy-client";
import {createBillingOpsNativeDriver} from "./testing/billing-ops-native-driver";
const requireBuilt=createRequire(resolve("package.json"));
const {BillingAccountController,BILLING_SYNC_TOKEN_HASH}=requireBuilt(resolve("dist/apps/orchestration-service/billing/billing-account.controller.js"));
const {EngineBillingAccountService}=requireBuilt(resolve("dist/apps/orchestration-service/billing/billing-account.service.js"));
const database=process.env.DATABASE_URL;
describe.skipIf(!database).sequential("durable staff credits actual authenticated Engine HTTP and ordinary PostgreSQL",()=>{
 let container:StartedPostgreSqlContainer,admin:PostgresOrchestrationStoreProvider,store:PostgresOrchestrationStoreProvider,app:NestFastifyApplication,d:Awaited<ReturnType<typeof createBillingOpsNativeDriver>>,client:BillingPolicyClient,dropAck=false,malformedAck=false,validCredential=true;
 const credential=randomBytes(24).toString("hex"),grants:string[]=[];
 beforeAll(async()=>{
  container=await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();const migrationsFolder=resolve("apps/orchestration-service/drizzle");admin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:container.getConnectionUri(),migrationsFolder});await admin.migrate();
  const password=randomBytes(24).toString("hex");await admin.withTenant("00000000-0000-7000-8000-000000000001",async tx=>{await tx.query(`CREATE ROLE staff_credit_engine LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);await tx.query("GRANT USAGE ON SCHEMA public TO staff_credit_engine");await tx.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO staff_credit_engine");});const url=new URL(container.getConnectionUri());url.username="staff_credit_engine";url.password=password;store=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:url.href,migrationsFolder});
  const service=new EngineBillingAccountService(store),module=await Test.createTestingModule({controllers:[BillingAccountController],providers:[{provide:EngineBillingAccountService,useValue:service},{provide:BILLING_SYNC_TOKEN_HASH,useValue:createHash("sha256").update(credential).digest("hex")}]}).compile();app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.init();await app.listen(0,"127.0.0.1");
  // eslint-disable-next-line alterx-boundaries/no-raw-engine-http -- controlled transport drops an acknowledgement only after the actual Engine client request commits.
  client=new BillingPolicyClient(await app.getUrl(),async()=>validCredential?credential:"invalid-staff-credit-credential",async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith("/grant")){grants.push(JSON.parse(init!.body as string).eventRef);if(dropAck){dropAck=false;throw new Error("Acknowledgement lost after actual committed grant");}if(malformedAck){malformedAck=false;return Response.json({unconfirmed:true});}}return response;});
 },120000);
 beforeEach(async()=>{dropAck=false;malformedAck=false;validCredential=true;grants.length=0;d=await createBillingOpsNativeDriver(client);await d.policy.synchronize(d.tenant);},60000);
 afterEach(async()=>{await d?.close();},60000);
 afterAll(async()=>{await app?.close();await store?.close();await admin?.close();await container?.stop();},60000);
 const grant=async(runs:number)=>d.service.apply(d.tenant,"stf_native_ops",{action:"grant_credits",runs,reason:"Actual Engine recovery proof"},await d.revision());
 it("retries the same durable grant after lost acknowledgement and credits exactly once",async()=>{
  expect((await store.withTenant(d.tenant,tx=>tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});dropAck=true;const accepted=await grant(3);expect(accepted.delivery).toBe("pending");expect(await client.account(d.tenant)).toMatchObject({balance:"6",available:"6"});
  await d.policy.synchronize(d.tenant);expect((await d.repository.history(d.tenant)).find(row=>row.id===accepted.id)?.delivery).toBe("delivered");expect(await client.account(d.tenant)).toMatchObject({balance:"6",available:"6"});expect(grants.filter(ref=>ref===`staff-credit:${accepted.id}`)).toHaveLength(2);
  const actual=await store.withTenant(d.tenant,tx=>tx.query("SELECT event_ref,credits FROM billing_credit_grants WHERE tenant_id=$1",[d.tenant]));expect(actual.rows).toEqual([{event_ref:`staff-credit:${accepted.id}`,credits:6}]);
 });
 it("keeps malformed acknowledgement pending and accepts the later duplicate acknowledgement without extra credits",async()=>{
  malformedAck=true;const accepted=await grant(2);expect(accepted.delivery).toBe("pending");expect(await client.account(d.tenant)).toMatchObject({balance:"4"});await d.policy.synchronize(d.tenant);expect((await d.repository.history(d.tenant)).find(row=>row.id===accepted.id)?.delivery).toBe("delivered");expect(await client.account(d.tenant)).toMatchObject({balance:"4"});
 });
 it("rejects missing and invalid service credentials, retaining pending work until credentials recover",async()=>{
  expect((await app.inject({method:"POST",url:"/internal/billing/grant",payload:{tenantId:`ten_${d.tenant}`,eventRef:"forged",credits:100}})).statusCode).toBe(401);validCredential=false;const accepted=await grant(1);expect(accepted.delivery).toBe("pending");validCredential=true;expect(await client.account(d.tenant)).toMatchObject({balance:"0"});await d.policy.synchronize(d.tenant);expect(await client.account(d.tenant)).toMatchObject({balance:"2"});expect((await d.repository.history(d.tenant)).find(row=>row.id===accepted.id)?.delivery).toBe("delivered");
 });
 it("does not expose another tenant's grants or balance and rejects a conflicting replay quantity",async()=>{
  const accepted=await grant(1);expect(accepted.delivery).toBe("delivered");await d.policy.synchronize(d.other);expect(await client.account(d.other)).toMatchObject({balance:"0",available:"0"});const rows=await store.withTenant(d.other,tx=>tx.query("SELECT * FROM billing_credit_grants WHERE tenant_id=$1",[d.tenant]));expect(rows.rowCount).toBe(0);await expect(client.grant(d.tenant,grants[0]!,99)).rejects.toThrow();expect(await client.account(d.tenant)).toMatchObject({balance:"2"});
 });
});
