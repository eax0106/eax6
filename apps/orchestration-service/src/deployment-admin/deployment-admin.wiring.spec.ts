import "reflect-metadata";
import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("../orchestration-infrastructure.module",async original=>({...await original<typeof import("../orchestration-infrastructure.module")>(),orchestrationStore:()=>({withTenant:vi.fn()}),identityTenantGatewayEnvironment:()=>({})}));
import {OperationsModule} from "../operations.module";
import {DeploymentAdminService} from "./deployment-admin.service";
const provider=()=>{const found=(Reflect.getMetadata("providers",OperationsModule) as {provide:unknown;useFactory?:()=>DeploymentAdminService}[]).find(value=>value.provide===DeploymentAdminService);if(!found?.useFactory)throw new Error("Deployment production provider missing");return found.useFactory;};
afterEach(()=>vi.unstubAllEnvs());
describe("deployment production audit wiring",()=>{
 it("refuses to create the actual real-mode provider without a configured mandatory audit transport",()=>{vi.stubEnv("RUNTIME_MODE","real");vi.stubEnv("AUDIT_SERVICE_GRPC_ADDRESS","");expect(()=>provider()()).toThrow(/AUDIT_SERVICE_GRPC_ADDRESS is required/);});
 it("creates the actual provider with a configured audit transport",()=>{vi.stubEnv("RUNTIME_MODE","real");vi.stubEnv("AUDIT_SERVICE_GRPC_ADDRESS","127.0.0.1:50068");expect(provider()()).toBeInstanceOf(DeploymentAdminService);});
});
