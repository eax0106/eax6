import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react"
import {QueryClient,QueryClientProvider} from "@tanstack/react-query"
const fixture=vi.hoisted(()=>({live:true}))
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),get isLiveApi(){return fixture.live}}))
import {SecurityQueue} from "./security-queue"
const id="abs_018f47a5-7b2c-7d10-8f11-123456789abc",tenant="018f47a5-7b2c-7d10-8f11-123456789abd"
const fetcher=vi.fn<typeof fetch>()
let item:Record<string,unknown>,pickerUnavailable=false,stale=false,auditUnavailable=false,listUnavailable=false,empty=false
beforeEach(()=>{
 fixture.live=true;pickerUnavailable=false;stale=false;auditUnavailable=false;listUnavailable=false;empty=false
 item={id,tenant_id:tenant,signal_type:"payment_fraud",source:"billing.recorded",score:60,evidence_ref:"evt_actual",observed_at:"2026-10-05T00:00:00.000Z",status:"open",etag:'"actual-rev-1"',assignment:null}
 fetcher.mockReset();vi.stubGlobal("fetch",fetcher)
 fetcher.mockImplementation(async(url,init)=>{
  const path=new URL(String(url),"http://app.test").pathname
  if(path.endsWith("/staff"))return pickerUnavailable?Response.json({detail:"Staff picker unavailable"},{status:503}):Response.json([{id:"stf_actual",email:"actual-reviewer@test.test",roles:["staff_security"]}])
  if(path.endsWith("/actions/assign")||path.endsWith("/actions/review")){
   if(stale)return Response.json({detail:"Reload the current security review"},{status:412})
   if(auditUnavailable)return Response.json({detail:"Audit unavailable"},{status:503})
   const body=JSON.parse(String(init?.body))
   if(path.endsWith("/assign"))item={...item,etag:'"actual-rev-2"',assignment:{staff_user_id:body.staff_user_id,staff_email:"actual-reviewer@test.test",active:true,assigned_by:"stf_actor",assigned_at:"2026-10-05T00:00:00.000Z",reason:body.reason}}
   else item={...item,etag:'"actual-rev-2"',status:body.decision==="confirm"?"confirmed":"dismissed"}
   return Response.json(item,{status:201})
  }
  return listUnavailable?Response.json({detail:"Reviews unavailable"},{status:503}):Response.json(empty?[]:[item])
 })
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function view(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SecurityQueue/></QueryClientProvider>)}
async function assignmentForm(){fireEvent.click(await screen.findByRole("button",{name:"Assign"}));await screen.findByRole("option",{name:"actual-reviewer@test.test"});fireEvent.change(screen.getByRole("combobox",{name:"Assign to"}),{target:{value:"stf_actual"}});fireEvent.change(screen.getByRole("textbox",{name:"Review reason"}),{target:{value:"Investigate recorded evidence"}})}
describe("security review assignment live and demo UI",()=>{
 it("assigns an actual eligible staff member with reason, exact revision and visible recorded assignee",async()=>{
  view();await assignmentForm();fireEvent.click(screen.getByRole("button",{name:"Save assignment"}));await screen.findByRole("button",{name:"Reassign"})
  expect(screen.getByText("actual-reviewer@test.test")).toBeTruthy();expect(screen.getByText("Investigate recorded evidence")).toBeTruthy();expect(screen.getByText("investigating")).toBeTruthy()
  const call=fetcher.mock.calls.find(([url])=>String(url).endsWith("/assign"))!;expect(JSON.parse(String(call[1]?.body))).toEqual({staff_user_id:"stf_actual",reason:"Investigate recorded evidence"});expect(new Headers(call[1]?.headers).get("if-match")).toBe('"actual-rev-1"');expect(call[1]?.credentials).toBe("include")
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith("/signals")).length).toBeGreaterThanOrEqual(2)
 })
 it("disables assignment until a staff member and bounded human reason are present",async()=>{
  view();fireEvent.click(await screen.findByRole("button",{name:"Assign"}));const button=screen.getByRole("button",{name:"Save assignment"}) as HTMLButtonElement
  expect(button.disabled).toBe(true);await screen.findByRole("option",{name:"actual-reviewer@test.test"});fireEvent.change(screen.getByRole("combobox",{name:"Assign to"}),{target:{value:"stf_actual"}});expect(button.disabled).toBe(true)
  const reason=screen.getByRole("textbox",{name:"Review reason"});expect(reason.getAttribute("maxlength")).toBe("1000");fireEvent.change(reason,{target:{value:"   "}});expect(button.disabled).toBe(true);fireEvent.change(reason,{target:{value:"Explicit investigation"}});expect(button.disabled).toBe(false)
 })
 it("keeps unsaved reason and assignee visible after stale or audit failure and reloads truthfully",async()=>{
  stale=true;view();await assignmentForm();fireEvent.click(screen.getByRole("button",{name:"Save assignment"}));expect((await screen.findByRole("alert")).textContent).toContain("Reload the current security review")
  expect((screen.getByRole("textbox",{name:"Review reason"}) as HTMLTextAreaElement).value).toBe("Investigate recorded evidence");expect((screen.getByRole("combobox",{name:"Assign to"}) as HTMLSelectElement).value).toBe("stf_actual");expect(screen.queryByRole("button",{name:"Reassign"})).toBeNull()
  stale=false;auditUnavailable=true;fireEvent.click(screen.getByRole("button",{name:"Save assignment"}));await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("Audit unavailable"));expect(screen.queryByRole("button",{name:"Reassign"})).toBeNull()
  auditUnavailable=false;fireEvent.click(screen.getByRole("button",{name:"Save assignment"}));await screen.findByRole("button",{name:"Reassign"})
 })
 it("exposes picker failure without offering invented staff and permits actual reload",async()=>{
  pickerUnavailable=true;view();fireEvent.click(await screen.findByRole("button",{name:"Assign"}));expect((await screen.findByRole("alert")).textContent).toContain("Staff picker unavailable");expect((screen.getByRole("button",{name:"Save assignment"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByRole("option",{name:"security@example.test"})).toBeNull()
  pickerUnavailable=false;fireEvent.click(screen.getByRole("button",{name:"Reload staff"}));await screen.findByRole("option",{name:"actual-reviewer@test.test"})
 })
 it("records a decision with human reason and current revision, then removes closed actions",async()=>{
  view();fireEvent.click(await screen.findByRole("button",{name:"Dismiss"}));fireEvent.change(screen.getByRole("textbox",{name:"Review reason"}),{target:{value:"Recorded evidence does not confirm abuse"}});fireEvent.click(screen.getByRole("button",{name:"Save decision"}));await screen.findByText("dismissed")
  expect(screen.queryByRole("button",{name:"Assign"})).toBeNull();const call=fetcher.mock.calls.find(([url])=>String(url).endsWith("/review"))!;expect(JSON.parse(String(call[1]?.body))).toEqual({decision:"dismiss",reason:"Recorded evidence does not confirm abuse"});expect(new Headers(call[1]?.headers).get("if-match")).toBe('"actual-rev-1"')
 })
 it("distinguishes actual empty reviews from unavailable and inactive assignment",async()=>{
  empty=true;view();await screen.findByText("No security issues found.");cleanup();empty=false;listUnavailable=true;view();expect((await screen.findByRole("alert")).textContent).toContain("Reviews unavailable");expect(screen.queryByText("No security issues found.")).toBeNull()
  listUnavailable=false;item={...item,assignment:{staff_user_id:"stf_actual",staff_email:"actual-reviewer@test.test",active:false,assigned_by:"stf_actor",assigned_at:"2026-10-05T00:00:00.000Z",reason:"Earlier assignment"}};fireEvent.click(screen.getByRole("button",{name:"Reload reviews"}));await screen.findByText("Assignee no longer eligible")
 })
 it("supports explicit demo staff assignment and preserves it after reload without live HTTP",async()=>{
  fixture.live=false;view();const buttons=await screen.findAllByRole("button",{name:"Assign"});fireEvent.click(buttons[0]!);await screen.findByRole("option",{name:"security@example.test"});fireEvent.change(screen.getByRole("combobox",{name:"Assign to"}),{target:{value:"stf_demo_security"}});fireEvent.change(screen.getByRole("textbox",{name:"Review reason"}),{target:{value:"Demo investigation"}});fireEvent.click(screen.getByRole("button",{name:"Save assignment"}));await screen.findByText("Demo investigation");expect(screen.getByText("security@example.test")).toBeTruthy();expect(fetcher).not.toHaveBeenCalled()
 })
})
