import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {cleanup,fireEvent,render,screen} from "@testing-library/react"
import {QueryClient,QueryClientProvider} from "@tanstack/react-query"
import {MemoryRouter,Route,Routes} from "react-router-dom"
const fixture=vi.hoisted(()=>({live:true}))
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),get isLiveApi(){return fixture.live}}))
import {TenantDetail} from "./tenant-detail"
const id="018f47a5-7b2c-7d10-8f11-123456789abc"
const fetcher=vi.fn<typeof fetch>()
let unavailable=false
let notes:Record<string,unknown>[]=[]
beforeEach(()=>{
 fixture.live=true;unavailable=false;notes=[];fetcher.mockReset();vi.stubGlobal("fetch",fetcher)
 fetcher.mockImplementation(async(url,options)=>{
  const path=new URL(String(url),"http://app.test").pathname
  if(path.endsWith("/admin/session"))return Response.json({staffUserId:"stf_note",email:"staff@test.test",roles:["staff_support"]})
  if(path.endsWith("/staff-access/grants"))return Response.json({data:[{id:"jit_notes",tenant_id:id,scopes:["tenant:read"],expires_at:new Date(Date.now()+60000).toISOString()}]})
  if(path.endsWith("/actions"))return Response.json(notes)
  if(path.endsWith("/notes")){
   if(unavailable)return Response.json({detail:"Audit unavailable"},{status:503})
   const body=JSON.parse(String(options?.body)) as {body:string}
   const row={id:"note_actual",action:"note_added",reason:body.body,staff_email:"staff@test.test",occurred_at:"2026-10-05T00:00:00Z"};notes.unshift(row);return Response.json(row,{status:201})
  }
  return Response.json({id,name:"Notes tenant",status:"active",created_at:"2026-10-05T00:00:00Z"})
 })
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function view(value=id){render(<MemoryRouter initialEntries={[`/tenants/${value}`]}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Routes><Route path="/tenants/:tenantId" element={<TenantDetail/>}/></Routes></QueryClientProvider></MemoryRouter>)}
describe("tenant append-only staff notes",()=>{
 it("appends through live HTTP and refreshes recorded staff history",async()=>{
  view();await screen.findByRole("button",{name:"Add note"})
  const button=screen.getByRole("button",{name:"Add note"});expect((button as HTMLButtonElement).disabled).toBe(true)
  const field=screen.getByRole("textbox",{name:"New administrative note"});expect(field.getAttribute("maxlength")).toBe("4000")
  fireEvent.change(field,{target:{value:"  Staff follow-up  "}});fireEvent.click(button);await screen.findByText("Note added.")
  await screen.findByText("note added: Staff follow-up");expect((field as HTMLTextAreaElement).value).toBe("")
  const call=fetcher.mock.calls.find(([url])=>String(url).endsWith("/notes"))!;expect(JSON.parse(String(call[1]?.body))).toEqual({body:"Staff follow-up"});expect(call[1]?.credentials).toBe("include")
  expect(new Headers(call[1]?.headers).get("x-alter-support-grant")).toBe("jit_notes")
 })
 it("keeps unsaved text visible when the service fails and permits retry",async()=>{
  unavailable=true;view();const field=await screen.findByRole("textbox",{name:"New administrative note"});fireEvent.change(field,{target:{value:"Retain this note"}});fireEvent.click(screen.getByRole("button",{name:"Add note"}));expect((await screen.findByRole("alert")).textContent).toContain("Audit unavailable");expect((field as HTMLTextAreaElement).value).toBe("Retain this note");expect(screen.queryByText("Note added.")).toBeNull()
  unavailable=false;fireEvent.click(screen.getByRole("button",{name:"Add note"}));await screen.findByText("Note added.")
 })
 it("appends and refreshes demo history",async()=>{
  fixture.live=false;view("ten-1 ".trim());const field=await screen.findByRole("textbox",{name:"New administrative note"});fireEvent.change(field,{target:{value:"Demo follow-up"}});fireEvent.click(screen.getByRole("button",{name:"Add note"}));await screen.findByText("Note added.");await screen.findByText("Demo follow-up");expect(fetcher).not.toHaveBeenCalled()
 })
})
