import {describe,expect,it,vi} from "vitest";
import {DeploymentAdminService} from "./deployment-admin.service";
const request={tenant_id:"018f4d6e-2b4a-7a3e-8c1a-1234567890ab",deployment_id:"dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",action:"suspend" as const,reason:"Incident investigation"};
describe("deployment action boundary",()=>{
 it("rejects missing current revision before touching storage",async()=>{
  const withTenant=vi.fn();const service=new DeploymentAdminService({withTenant},{recordEvent:vi.fn()});
  await expect(service.apply(request,"stf_admin",undefined)).rejects.toMatchObject({status:428});expect(withTenant).not.toHaveBeenCalled();
 });
 it("rejects an untrusted staff assertion before touching storage",async()=>{
  const withTenant=vi.fn();const service=new DeploymentAdminService({withTenant},{recordEvent:vi.fn()});
  await expect(service.apply(request,"usr_member",'"current"')).rejects.toThrow();expect(withTenant).not.toHaveBeenCalled();
 });
});
