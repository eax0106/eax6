import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {listTenantDeployments,applyTenantDeployment} from "./live-admin-deployments"
const fetcher=vi.fn<typeof fetch>(),tenant="018f4d6e-2b4a-7a3e-8c1a-1234567890ab",other="018f4d6e-2b4a-7a3e-8c1a-1234567890ac",id="dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",project="prj_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal("fetch",fetcher)})
afterEach(()=>vi.unstubAllGlobals())
describe("live tenant deployments",()=>{
 it("accepts a genuinely empty tenant collection and binds the requested tenant",async()=>{fetcher.mockResolvedValue(Response.json({tenant_id:tenant,total:0,items:[]}));expect(await listTenantDeployments(tenant)).toEqual({tenant_id:tenant,total:0,items:[]});expect(String(fetcher.mock.calls[0]![0])).toContain(`tenant_id=${tenant}`);expect(fetcher.mock.calls[0]![1]?.credentials).toBe("include")})
 it.each([{tenant_id:other,total:0,items:[]},{tenant_id:tenant,total:201,items:Array(201).fill({})},{tenant_id:tenant,total:0,items:[{}]},[]])("rejects malformed, oversized or misbound collection %#",async(body)=>{fetcher.mockResolvedValue(Response.json(body));await expect(listTenantDeployments(tenant)).rejects.toThrow()})
 it("forwards exact revision, validates scope and action on the acknowledged result",async()=>{
  const input={tenant_id:tenant,deployment_id:id,action:"suspend" as const,reason:"Actual reason"},result={...input,project_id:project,status:"suspended",active_deployment_id:null,updated_at:"2026-10-05T00:00:00Z",etag:`"${id}:rev-2"`};const {reason:_,...body}=result;fetcher.mockResolvedValue(Response.json(body));expect(await applyTenantDeployment(input,`"${id}:rev-1"`)).toMatchObject({status:"suspended"});expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("if-match")).toBe(`"${id}:rev-1"`)
  fetcher.mockResolvedValue(Response.json({...body,tenant_id:other}));await expect(applyTenantDeployment(input,'"current"')).rejects.toThrow(/mismatch/);await expect(applyTenantDeployment(input,"")).rejects.toThrow(/Reload/)
 })
})
