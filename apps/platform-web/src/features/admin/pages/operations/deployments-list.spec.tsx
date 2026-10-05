import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react"
import {QueryClient,QueryClientProvider} from "@tanstack/react-query"
const fixture=vi.hoisted(()=>({live:true}))
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),get isLiveApi(){return fixture.live}}))
import {DeploymentsList} from "./deployments-list"
const tenant="018f4d6e-2b4a-7a3e-8c1a-1234567890ab",other="018f4d6e-2b4a-7a3e-8c1a-1234567890ac",id="dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",project="prj_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
const fetcher=vi.fn<typeof fetch>()
let roles:string[],listUnavailable:boolean,tenantUnavailable:boolean,empty:boolean,actionStatus:number,status:string,etag:string
const row=()=>({id,tenant_id:tenant,project_id:project,project_name:"Recorded actual project",status,created_at:"2026-10-05T00:00:00.000Z",updated_at:"2026-10-05T00:00:00.000Z",etag})
beforeEach(()=>{
 fixture.live=true;roles=["staff_admin"];listUnavailable=false;tenantUnavailable=false;empty=false;actionStatus=201;status="active";etag=`"${id}:rev-1"`;vi.stubGlobal("fetch",fetcher);fetcher.mockReset()
 fetcher.mockImplementation(async(input,init)=>{
  const url=new URL(String(input),"http://app.test")
  if(url.pathname.endsWith("/admin/session"))return Response.json({staffUserId:"stf_deployment",email:"admin@test.test",roles})
  if(url.pathname.endsWith("/admin/tenants"))return tenantUnavailable?Response.json({detail:"Tenant list unavailable"},{status:503}):Response.json([{id:tenant,name:"Recorded tenant",status:"active",created_at:"2026-10-05T00:00:00Z"},{id:other,name:"Other tenant",status:"active",created_at:"2026-10-05T00:00:00Z"}])
  if(url.pathname.endsWith("/actions/apply")){
   if(actionStatus!==201)return Response.json({detail:actionStatus===412?"Deployment changed":"Audit unavailable"},{status:actionStatus})
   const body=JSON.parse(String(init?.body)) as {action:string};status=body.action==="resume"?"active":body.action==="rollback"?"rolled_back":"suspended";etag=`"${id}:rev-2"`
   return Response.json({tenant_id:tenant,deployment_id:id,project_id:project,action:body.action,status,active_deployment_id:status==="active"?id:null,updated_at:"2026-10-05T01:00:00.000Z",etag},{status:201})
  }
  if(url.pathname.endsWith("/admin/deployments")){
   if(listUnavailable)return Response.json({detail:"Engine unavailable"},{status:502})
   const scope=url.searchParams.get("tenant_id")!
   return Response.json({tenant_id:scope,total:empty?0:1,items:empty?[]:[{...row(),tenant_id:scope,project_name:scope===tenant?"Recorded actual project":"Other recorded project"}]})
  }
  throw new Error("Unexpected native web request")
 })
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function view(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><DeploymentsList/></QueryClientProvider>)}
async function choose(){const select=await screen.findByRole("combobox",{name:"Tenant"});await screen.findByRole("option",{name:"Recorded tenant"});fireEvent.change(select,{target:{value:tenant}});}
describe("actual tenant deployment administration",()=>{
 it("offers a named tenant selector without fetching a fictional default deployment",async()=>{view();expect(await screen.findByRole("heading",{name:"Tenant deployments"})).toBeTruthy();await screen.findByRole("combobox",{name:"Tenant"});expect(screen.queryByText("v2.14.2")).toBeNull();expect(fetcher.mock.calls.some(([url])=>String(url).includes("/admin/deployments"))).toBe(false)})
 it("loads actual selected tenant records and submits displayed revision with a human reason",async()=>{
  view();await choose();await screen.findByText("Recorded actual project");fireEvent.click(screen.getByRole("button",{name:"Suspend"}));const field=screen.getByRole("textbox",{name:"Deployment action reason"}),button=screen.getByRole("button",{name:"Apply action"});expect((button as HTMLButtonElement).disabled).toBe(true);expect(field.getAttribute("maxlength")).toBe("1000")
  fireEvent.change(field,{target:{value:"  Investigate provider incident  "}});fireEvent.click(button);await screen.findByText("Deployment state updated.");await screen.findByRole("button",{name:"Resume"})
  const call=fetcher.mock.calls.find(([url])=>String(url).endsWith("/actions/apply"))!;expect(JSON.parse(String(call[1]?.body))).toEqual({tenant_id:tenant,deployment_id:id,action:"suspend",reason:"Investigate provider incident"});expect(new Headers(call[1]?.headers).get("if-match")).toBe(`"${id}:rev-1"`);expect(call[1]?.credentials).toBe("include");expect(screen.queryByRole("textbox")).toBeNull()
 })
 it.each([412,500])("retains unsaved reason on action failure %s",async(code)=>{
  actionStatus=code;view();await choose();fireEvent.click(await screen.findByRole("button",{name:"Rollback"}));const field=screen.getByRole("textbox",{name:"Deployment action reason"});fireEvent.change(field,{target:{value:"Keep this investigation reason"}});fireEvent.click(screen.getByRole("button",{name:"Apply action"}));expect((await screen.findByRole("alert")).textContent).toContain(code===412?"Deployment changed":"Audit unavailable");expect((field as HTMLTextAreaElement).value).toBe("Keep this investigation reason");expect(screen.queryByText("Deployment state updated.")).toBeNull()
 })
 it("distinguishes unavailable from empty and permits a successful reload",async()=>{
  listUnavailable=true;view();await choose();expect((await screen.findByRole("alert")).textContent).toContain("Engine unavailable");expect(screen.queryByText("No deployments found for this tenant.")).toBeNull();expect(screen.queryByRole("button",{name:"Suspend"})).toBeNull();listUnavailable=false;empty=true;fireEvent.click(screen.getByRole("button",{name:"Reload deployments"}));await screen.findByText("No deployments found for this tenant.")
 })
 it("changes tenant scope and offers only valid actions for the returned state",async()=>{
  status="suspended";view();await choose();await screen.findByRole("button",{name:"Resume"});expect(screen.queryByRole("button",{name:"Rollback"})).toBeNull();fireEvent.change(screen.getByRole("combobox",{name:"Tenant"}),{target:{value:other}});await screen.findByText("Other recorded project");expect(screen.queryByText("Recorded actual project")).toBeNull();expect(fetcher.mock.calls.some(([url])=>String(url).includes(`tenant_id=${other}`))).toBe(true)
 })
 it("withholds reads without the current staff admin role and shows failed tenant discovery",async()=>{
  roles=["staff_security"];view();await screen.findByText("Staff admin role required.");expect(fetcher.mock.calls.some(([url])=>String(url).includes("/admin/tenants"))).toBe(false);cleanup();roles=["staff_admin"];tenantUnavailable=true;view();await screen.findByRole("button",{name:"Retry tenants"});expect(screen.queryByText("Recorded actual project")).toBeNull()
 })
 it("keeps demo transitions explicit and performs no live request",async()=>{
  fixture.live=false;view();await screen.findByText("Demo records — fictional deployments.");await screen.findByRole("option",{name:"Acme AI"});fireEvent.change(screen.getByRole("combobox",{name:"Tenant"}),{target:{value:"ten-1"}});const suspend=await screen.findByRole("button",{name:"Suspend"});fireEvent.click(suspend);fireEvent.change(screen.getByRole("textbox",{name:"Deployment action reason"}),{target:{value:"Demo investigation"}});fireEvent.click(screen.getByRole("button",{name:"Apply action"}));await screen.findByText("Deployment state updated.");await waitFor(()=>expect(screen.getAllByRole("button",{name:"Resume"})).toHaveLength(2));expect(fetcher).not.toHaveBeenCalled()
 })
})
