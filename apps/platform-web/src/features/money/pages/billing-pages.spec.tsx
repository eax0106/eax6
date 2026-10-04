import { afterEach,beforeEach,describe,expect,it,vi } from "vitest"
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { QueryClient,QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { installLiveWorkspaceSession,clearLiveWorkspaceSession } from "@/features/permissions/testing/session"
import type { BillingPlan,BillingSubscription } from "@/api/types"
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),isLiveApi:true}))
import { BillingPlansPage } from "./billing-plans"
import { BillingOverviewPage } from "./billing-overview"

const version="2026-10-05T00:00:00.000Z"
const commercial={currency:"INR" as const,basePriceMinor:10000,razorpayPlanId:"plan_basic",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2}
const subscriptionFields={tenantId:"ten_ui_fixture",currentPeriodStart:null,currentPeriodEnd:null,providerCustomerRef:null}
const checkout={currency:"INR" as const,basePriceMinor:10000,gstPercent:18 as const,gstMinor:1800,totalMinor:11800,gatewayFeeMinor:0 as const}
let plans:BillingPlan[],subscription:BillingSubscription|null,readFailure:boolean,writeFailure:boolean,checkoutUrl:string
const fetcher=vi.fn(async (url:string,init?:RequestInit)=>{
  const write=init?.method!=="GET" && Boolean(init?.method)
  let body:unknown=null,status=200
  if(write){
    if(writeFailure){body={detail:"Provider response unconfirmed; refresh billing status"};status=502}
    else {subscription={...subscriptionFields,id:"sub_checkout",planId:"basic",status:init?.method==="DELETE"?"active":"created",version,checkoutUrl,
      ...(init?.method==="DELETE"?{pendingOperation:"cancel" as const}:{}),checkoutSnapshot:checkout};body=subscription}
  }else if(url.endsWith("/plans"))body=plans
  else if(url.endsWith("/credits"))body={balance:"100",reserved:"4",available:"96"}
  else if(readFailure){body={detail:"Checkout setup has not been confirmed"};status=503}
  else body=subscription
  return Response.json(body,{status,headers:{ETag:'"displayed"'}})
})
beforeEach(()=>{
  plans=[{id:"free",name:"Free",version,limits:{maxRunsPerDay:3},commercial:null,checkout:null},
    {id:"basic",name:"Basic",version,limits:{maxRunsPerDay:25},commercial,checkout},
    {id:"pro",name:"Pro",version,limits:{maxRunsPerDay:100},commercial:null,checkout:null}]
  subscription=null;readFailure=false;writeFailure=false;checkoutUrl="https://rzp.io/i/checkout"
  act(()=>installLiveWorkspaceSession("owner"));fetcher.mockClear();vi.stubGlobal("fetch",fetcher)
  vi.spyOn(window,"confirm").mockReturnValue(true)
})
afterEach(()=>{cleanup();clearLiveWorkspaceSession();vi.unstubAllGlobals();vi.restoreAllMocks()})
function mount(overview=false){render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>
  {overview?<BillingOverviewPage/>:<BillingPlansPage/>}
</QueryClientProvider></MemoryRouter>)}
const writes=()=>fetcher.mock.calls.filter(([,init])=>init?.method && init.method!=="GET")

describe("configured billing UI",()=>{
  it("renders configured base, GST, total, credits and caps; refuses unset prices and invalid GSTIN",async()=>{
    mount();const buy=await screen.findByRole("button",{name:"Start checkout"})
    expect(screen.getByText("GST (18%): ₹18.00")).toBeTruthy();expect(screen.getByText("Total: ₹118.00")).toBeTruthy()
    expect(screen.getByText("100 credits per paid cycle")).toBeTruthy();expect(screen.getByText("3 runs per day")).toBeTruthy()
    expect((screen.getByRole("button",{name:"Unavailable"}) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button",{name:"Free tier"}) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("GSTIN (optional)"),{target:{value:"bad"}})
    expect((buy as HTMLButtonElement).disabled).toBe(true);fireEvent.click(buy);expect(writes()).toHaveLength(0)
    fireEvent.change(screen.getByLabelText("GSTIN (optional)"),{target:{value:"27abcde1234f1z5"}})
    fireEvent.click(buy)
    const link=await screen.findByRole("link",{name:"Continue secure Razorpay checkout"})
    expect(link.getAttribute("href")).toBe(checkoutUrl);expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({plan_id:"basic",plan_version:version,gstin:"27ABCDE1234F1Z5"})
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("₹118.00 including 18% GST"))
    expect(screen.getByText("Paid access starts after Razorpay confirms activation.")).toBeTruthy()
    await waitFor(()=>expect((screen.getByRole("button",{name:"Current plan"}) as HTMLButtonElement).disabled).toBe(true))
  })
  it("does not initiate checkout when confirmation is declined",async()=>{
    vi.mocked(window.confirm).mockReturnValue(false);mount();fireEvent.click(await screen.findByRole("button",{name:"Start checkout"}));expect(writes()).toHaveLength(0)
  })
  it.each(["https://rzp.io.evil.test/pay","javascript:alert(1)","https://user:pass@rzp.io/pay","https://rzp.io/pay#secret"])("never renders unsafe hosted checkout %s",async unsafe=>{
    subscription={...subscriptionFields,id:"sub_1",planId:"basic",status:"created",version,checkoutUrl:unsafe};mount()
    await screen.findByRole("button",{name:"Current plan"});expect(screen.queryByRole("link",{name:"Continue secure Razorpay checkout"})).toBeNull()
  })
  it("keeps provider errors visible and allows GET recovery without issuing another purchase",async()=>{
    writeFailure=true;mount();fireEvent.click(await screen.findByRole("button",{name:"Start checkout"}));await screen.findByText("Provider response unconfirmed; refresh billing status")
    subscription={...subscriptionFields,id:"sub_recovered",planId:"basic",status:"created",version,checkoutUrl};fireEvent.click(screen.getByRole("button",{name:"Refresh billing status"}))
    await screen.findByRole("link",{name:"Continue secure Razorpay checkout"});expect(writes()).toHaveLength(1)
  })
  it("blocks a failed subscription read and shows recovery error",async()=>{
    readFailure=true;mount();await screen.findByText("Checkout setup has not been confirmed")
    expect((screen.getByRole("button",{name:"Start checkout"}) as HTMLButtonElement).disabled).toBe(true);expect(writes()).toHaveLength(0)
  })
  it("prevents a viewer from checkout or cancellation",async()=>{
    act(()=>installLiveWorkspaceSession("viewer"));mount();expect((await screen.findByRole("button",{name:"Start checkout"}) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Only the tenant owner can change billing.")).toBeTruthy();cleanup()
    subscription={...subscriptionFields,id:"sub_active",planId:"basic",status:"active",version};mount(true)
    expect((await screen.findByRole("button",{name:"Cancel subscription"}) as HTMLButtonElement).disabled).toBe(true);expect(writes()).toHaveLength(0)
  })
  it("shows the original contract price and actual balance; cancellation uses displayed ETag and waits for confirmation",async()=>{
    subscription={...subscriptionFields,id:"sub_active",planId:"basic",status:"active",version,checkoutSnapshot:{...checkout,basePriceMinor:5000,gstMinor:900,totalMinor:5900},gstin:"27ABCDE1234F1Z5"};mount(true)
    const cancel=await screen.findByRole("button",{name:"Cancel subscription"})
    expect(screen.getByText("₹50.00 + GST ₹9.00 = ₹59.00 per billing cycle")).toBeTruthy();await screen.findByText("Available: 96")
    expect(screen.getByText("Reserved by running workflows: 4")).toBeTruthy();expect(screen.getByText("GSTIN: 27ABCDE1234F1Z5")).toBeTruthy()
    fireEvent.click(cancel);await screen.findByRole("status")
    expect(new Headers(writes()[0]![1]?.headers).get("If-Match")).toBe('"displayed"');expect(writes()[0]![1]?.method).toBe("DELETE")
    await waitFor(()=>expect((cancel as HTMLButtonElement).disabled).toBe(true))
  })
})
