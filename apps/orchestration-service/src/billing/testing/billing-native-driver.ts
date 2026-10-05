import { createHash,randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter,type NestFastifyApplication } from "@nestjs/platform-fastify";
import { BillingAccountController,BILLING_SYNC_TOKEN_HASH } from "../billing-account.controller";
import { EngineBillingAccountService } from "../billing-account.service";
let container:StartedPostgreSqlContainer,admin:PostgresOrchestrationStoreProvider,store:PostgresOrchestrationStoreProvider,app:NestFastifyApplication;
process.once("message",async(message:{token:string})=>{
  try{
    container=await new PostgreSqlContainer("postgres:16.6-alpine").start();
    const migrationsFolder=resolve("apps/orchestration-service/drizzle");
    admin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:container.getConnectionUri(),migrationsFolder});await admin.migrate();
    const role=`billing_driver_${randomBytes(5).toString("hex")}`,password=randomBytes(24).toString("hex");
    await admin.withTenant("00000000-0000-7000-8000-000000000001",async tx=>{await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);});
    const uri=new URL(container.getConnectionUri());uri.username=role;uri.password=password;
    store=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:uri.href,migrationsFolder});
    const module=await Test.createTestingModule({controllers:[BillingAccountController],providers:[{provide:EngineBillingAccountService,useValue:new EngineBillingAccountService(store)},{provide:BILLING_SYNC_TOKEN_HASH,useValue:createHash("sha256").update(message.token).digest("hex")}]}).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(),{logger:false});await app.listen(0,"127.0.0.1");process.send?.({ready:await app.getUrl()});
  }catch{process.send?.({error:"Native billing driver failed to start"});}
});
process.once("disconnect",async()=>{await app?.close();await store?.close();await admin?.close();await container?.stop();process.exit(0);});
