import { beforeEach,afterEach,describe,expect,it,vi } from "vitest"
import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { QueryClient,QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter,Route,Routes } from "react-router-dom"
const fixture=vi.hoisted(()=>({live:true,enabled:true}))
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),get isLiveApi(){return fixture.live}}))
vi.mock("@/api/staff-auth",()=>({getStaffSession:vi.fn(async()=>({roles:["staff_security"]}))}))
vi.mock("@/api/client",()=>({api:{admin:{
  users:{list:vi.fn(),get:vi.fn(),getNotes:vi.fn(async()=>[]),suspend:vi.fn(),restore:vi.fn(),lockSessions:vi.fn()},
  tenants:{list:vi.fn(),get:vi.fn(),getNotes:vi.fn(async()=>[]),activeGrant:vi.fn(),suspend:vi.fn(),restore:vi.fn()},
  providers:{list:vi.fn(),enable:vi.fn(),disable:vi.fn()},policies:{list:vi.fn(async()=>[])},
}}}))
import { api } from "@/api/client"
import { UserList } from "./users/user-list"
import { UserDetail } from "./users/user-detail"
import { TenantList } from "./tenants/tenant-list"
import { TenantDetail } from "./tenants/tenant-detail"
import { ProvidersList } from "./operations/providers-list"
import { PoliciesList } from "./governance/policies-list"
const user={id:"usr_test",name:"User fixture",email:"fixture@company.test",status:"active" as const,tenantIds:["ten_test"],createdAt:"2026-10-01T00:00:00Z",mfaEnabled:true,riskState:"restricted"}
const tenant={id:"ten_test",name:"Tenant fixture",status:"active" as const,createdAt:"2026-10-01T00:00:00Z",riskState:"restricted"}
beforeEach(()=>{
  vi.clearAllMocks();fixture.live=true;fixture.enabled=true
  vi.mocked(api.admin.users.list).mockResolvedValue([user]);vi.mocked(api.admin.users.get).mockResolvedValue(user)
  vi.mocked(api.admin.tenants.list).mockResolvedValue([tenant]);vi.mocked(api.admin.tenants.get).mockResolvedValue(tenant)
  vi.mocked(api.admin.providers.list).mockImplementation(async()=>[{id:"provider_test",name:"Provider fixture",type:"model",status:"healthy",enabled:fixture.enabled}])
  vi.mocked(api.admin.providers.disable).mockImplementation(async()=>{fixture.enabled=false;return {id:"provider_test",name:"Provider fixture",type:"model",status:"disabled",enabled:false}})
  vi.mocked(api.admin.providers.enable).mockImplementation(async()=>{fixture.enabled=true;return {id:"provider_test",name:"Provider fixture",type:"model",status:"healthy",enabled:true}})
})
afterEach(cleanup)
function view(element:React.ReactNode,path="/"){
 render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
 <Routes><Route path="/users/:userId" element={element}/><Route path="/tenants/:tenantId" element={element}/><Route path="/" element={element}/></Routes>
 </QueryClientProvider></MemoryRouter>)
}
describe.each([true,false])("D26 admin removals, live=%s",live=>{
 it("removes user MFA/risk columns and detail badges; links to Auth0 with supported user actions",async()=>{
   fixture.live=live;view(<UserList/>);await screen.findByText(user.name)
   expect(screen.queryByRole("columnheader",{name:"MFA"})).toBeNull();expect(screen.queryByRole("columnheader",{name:"Risk"})).toBeNull();cleanup()
   view(<UserDetail/>,"/users/usr_test");await screen.findByText(user.name)
   expect(screen.queryByText("MFA Status")).toBeNull();expect(screen.queryByText(/Risk:/)).toBeNull()
   const link=screen.getByRole("link",{name:"Open Auth0 dashboard"})
   expect(link.getAttribute("href")).toBe("https://manage.auth0.com/dashboard");expect(link.getAttribute("rel")).toBe("noopener noreferrer")
   fireEvent.click(screen.getByRole("button",{name:"Lock Sessions"}));await waitFor(()=>expect(api.admin.users.lockSessions).toHaveBeenCalledWith("usr_test","Session lock"))
   fireEvent.click(screen.getByRole("button",{name:"Suspend"}));await waitFor(()=>expect(api.admin.users.suspend).toHaveBeenCalledWith("usr_test","Admin intervention"))
 })
 it("removes invented tenant risk and preserves suspension",async()=>{
   fixture.live=live;view(<TenantList/>);await screen.findByText(tenant.name);expect(screen.queryByRole("columnheader",{name:"Risk"})).toBeNull();cleanup()
   view(<TenantDetail/>,"/tenants/ten_test");await screen.findByText(tenant.name);expect(screen.queryByText(/Risk:/)).toBeNull()
   fireEvent.click(screen.getByRole("button",{name:"Suspend Tenant"}));await waitFor(()=>expect(api.admin.tenants.suspend).toHaveBeenCalledWith("ten_test","Admin intervention"))
 })
 it("removes maintenance and retains enable/disable actions",async()=>{
   fixture.live=live;view(<ProvidersList/>);await screen.findByText("Provider fixture")
   expect(screen.queryByTitle("Mark for Maintenance")).toBeNull();fireEvent.click(screen.getByTitle("Disable Provider"))
   await waitFor(()=>expect(api.admin.providers.disable).toHaveBeenCalledWith("provider_test"));await screen.findByTitle("Enable Provider")
   fireEvent.click(screen.getByTitle("Enable Provider"));await waitFor(()=>expect(api.admin.providers.enable).toHaveBeenCalledWith("provider_test"))
   expect(api.admin.providers).not.toHaveProperty("markMaintenance")
 })
 it("offers read-only policy configuration with no new or edit controls",async()=>{
   fixture.live=live;view(<PoliciesList/>);await screen.findByText("No policies found.")
   expect(screen.queryByRole("button",{name:/Policy/})).toBeNull();expect(screen.getByText(/Changes go through reviewed configuration/)).toBeTruthy()
 })
})
