import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { installLiveWorkspaceSession, clearLiveWorkspaceSession } from "@/features/permissions/testing/session"
import type { BillingPlan, BillingSubscription } from "@/api/types"
import type { CreditPurchaseView } from "@alterx/contracts"

const mode = vi.hoisted(()=>({live:true}))
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),get isLiveApi(){return mode.live}}))
import { CreditPurchaseCard } from "./credit-purchase"
import { BillingOverviewPage } from "./billing-overview"

const version="2026-10-05T00:00:00.000Z", id="cpx_019a3258-1000-7000-8000-000000000001"
const plan:BillingPlan={id:"basic",name:"Basic",version,limits:{maxRunsPerDay:25},commercial:{currency:"INR",basePriceMinor:10000,
  razorpayPlanId:"plan_basic",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2},checkout:null}
const subscription:BillingSubscription={id:"sub_active",tenantId:"ten_fixture",planId:"basic",status:"active",version,
  currentPeriodStart:null,currentPeriodEnd:null,providerCustomerRef:null}
function purchase(state:CreditPurchaseView["state"]="checkout_ready",revision=2):CreditPurchaseView {
  return {id,quote:{planId:"basic",planVersion:version,credits:10,unitPriceMinor:50,creditsPerVerifiedRun:2,basePriceMinor:500,
    gstPercent:18,gstMinor:90,totalMinor:590,currency:"INR",gatewayFeeMinor:0},gstin:null,state,
    checkoutUrl:"https://rzp.io/i/extra-credit",createdAt:version,updatedAt:version,revision}
}
let current:CreditPurchaseView|undefined, createFailure:boolean, historyFailure:boolean, refreshFailure:boolean, namedFailure:boolean
const handlePurchase=async (url:string,init?:RequestInit)=>{
  let body:unknown, status=200
  const write=init?.method==="POST"
  if(write && !url.endsWith("/refresh")) {
    if(createFailure) {body={detail:"Provider response unconfirmed"};status=502}
    else {const input=JSON.parse(String(init?.body));current={...purchase(),gstin:input.gstin??null};body=current}
  } else if(write) {
    if(refreshFailure){body={detail:"Purchase revision changed; reload"};status=412}
    else {current=purchase("delivery_pending",3);body=current}
  } else if(url.endsWith("/credit-purchases")) {
    if(historyFailure){body={detail:"Inventory unavailable"};status=503}else body=current?[current]:[]
  } else if(namedFailure){body={detail:"Named purchase unavailable"};status=503}
  else body=current
  return Response.json(body??null,{status,headers:current?{ETag:`"credit-purchase-${current.id}-${current.revision}"`}:{}})
}
const fetcher=vi.fn(handlePurchase)
beforeEach(()=>{
  mode.live=true;current=undefined;createFailure=false;historyFailure=false;refreshFailure=false;namedFailure=false
  fetcher.mockReset().mockImplementation(handlePurchase);vi.stubGlobal("fetch",fetcher);act(()=>installLiveWorkspaceSession("owner"))
})
afterEach(()=>{cleanup();clearLiveWorkspaceSession();vi.unstubAllGlobals();vi.restoreAllMocks()})
function mount(selectedPlan:BillingPlan|undefined=plan,selectedSubscription:BillingSubscription|null=subscription){
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
  render(<QueryClientProvider client={client}><CreditPurchaseCard plan={selectedPlan} subscription={selectedSubscription}/></QueryClientProvider>)
  return client
}
const writes=()=>fetcher.mock.calls.filter(([,init])=>init?.method==="POST")
async function buyButton(){const button=await screen.findByRole("button",{name:"Prepare extra-credit checkout"});await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));return button}

describe("configured extra-credit billing card",()=>{
  it("reloads actual configured plan prices and preserves quantity and GSTIN without another purchase",async()=>{
    let configuredPlan=plan
    fetcher.mockImplementation(async(url,init)=>{
      if(url.endsWith("/plans"))return Response.json([configuredPlan])
      if(url.endsWith("/subscription"))return Response.json(subscription,{headers:{ETag:'"subscription-current"'}})
      if(url.endsWith("/credits"))return Response.json({balance:"100",reserved:"0",available:"100"})
      return handlePurchase(url,init)
    })
    const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
    render(<MemoryRouter><QueryClientProvider client={client}><BillingOverviewPage/></QueryClientProvider></MemoryRouter>)
    await buyButton()
    fireEvent.change(screen.getByLabelText("Execution credits"),{target:{value:"12"}})
    fireEvent.change(screen.getByLabelText("Extra-credit GSTIN (optional)"),{target:{value:"27abcde1234f1z5"}})
    configuredPlan={...plan,version:"2026-10-06T00:00:00.000Z",commercial:{...plan.commercial!,extraCreditPriceMinor:75}}
    fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByText("₹0.75 per execution credit; 2 credits per verified run.")
    expect(screen.getByText("Credits: ₹9.00 + GST (18%): ₹1.62 = ₹10.62 total. No gateway fee added.")).toBeTruthy()
    expect((screen.getByLabelText("Execution credits") as HTMLInputElement).value).toBe("12")
    expect((screen.getByLabelText("Extra-credit GSTIN (optional)") as HTMLInputElement).value).toBe("27abcde1234f1z5")
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith("/plans")).length).toBeGreaterThanOrEqual(2)
    expect(writes()).toHaveLength(0)
  })
  it("shows configured integer quote, validates quantity/GSTIN and keeps entered input after checkout",async()=>{
    mount();const button=await buyButton()
    expect(screen.getByText("₹0.50 per execution credit; 2 credits per verified run.")).toBeTruthy()
    expect(screen.getByText("Credits: ₹5.00 + GST (18%): ₹0.90 = ₹5.90 total. No gateway fee added.")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Execution credits"),{target:{value:"1.5"}})
    expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(writes()).toHaveLength(0)
    fireEvent.change(screen.getByLabelText("Execution credits"),{target:{value:"10"}})
    fireEvent.change(screen.getByLabelText("Extra-credit GSTIN (optional)"),{target:{value:"bad"}})
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Extra-credit GSTIN (optional)"),{target:{value:"27abcde1234f1z5"}})
    fireEvent.click(button)
    const link=await screen.findByRole("link",{name:"Continue extra-credit Razorpay checkout"})
    expect(link.getAttribute("href")).toBe("https://rzp.io/i/extra-credit");expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({credits:10,plan_version:version,gstin:"27ABCDE1234F1Z5"})
    expect((screen.getByLabelText("Extra-credit GSTIN (optional)") as HTMLInputElement).value).toBe("27abcde1234f1z5")
    expect(screen.getByText(/Returning from checkout does not confirm payment/)).toBeTruthy()
    expect(screen.queryByText(/^Credits delivered:/)).toBeNull()
  })
  it("recovers an uncertain response with GET only and preserves its request key when retried",async()=>{
    createFailure=true;mount();fireEvent.click(await buyButton());await screen.findByText("Provider response unconfirmed")
    await waitFor(()=>expect((screen.getByRole("button",{name:"Prepare extra-credit checkout"}) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button",{name:"Prepare extra-credit checkout"}));await waitFor(()=>expect(writes()).toHaveLength(2))
    expect(new Headers(writes()[0]![1]?.headers).get("Idempotency-Key")).toBe(new Headers(writes()[1]![1]?.headers).get("Idempotency-Key"))
    current=purchase();fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByRole("link",{name:"Continue extra-credit Razorpay checkout"});expect(writes()).toHaveLength(2)
  })
  it("uses displayed revision for payment refresh and shows delivery pending without inventing delivery",async()=>{
    current=purchase();mount();fireEvent.click(await screen.findByRole("button",{name:"Check extra-credit payment"}))
    await screen.findByText(/^Payment confirmed; credit delivery pending:/)
    expect(new Headers(writes()[0]![1]?.headers).get("If-Match")).toBe(`"credit-purchase-${id}-2"`)
    expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({})
    expect(screen.queryByRole("link",{name:"Continue extra-credit Razorpay checkout"})).toBeNull()
    expect(screen.queryByText(/^Credits delivered:/)).toBeNull()
  })
  it("shows stale errors and allows read recovery without another payment action",async()=>{
    current=purchase();refreshFailure=true;mount();fireEvent.click(await screen.findByRole("button",{name:"Check extra-credit payment"}))
    await screen.findByText("Purchase revision changed; reload")
    current=purchase("delivered",4);fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByText(/^Credits delivered:/);expect(writes()).toHaveLength(1)
  })
  it("blocks payment refresh after the current named read fails and recovers through GET only",async()=>{
    current=purchase();mount();await screen.findByRole("button",{name:"Check extra-credit payment"})
    namedFailure=true;fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByText("Current purchase unavailable. Reload before taking another action.")
    const button=screen.getByRole("button",{name:"Check extra-credit payment"})
    expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(writes()).toHaveLength(0)
    namedFailure=false;fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));expect(writes()).toHaveLength(0)
  })
  it("after confirmed terminal delivery permits a new purchase with a fresh key",async()=>{
    mount();fireEvent.click(await buyButton());await screen.findByRole("link",{name:"Continue extra-credit Razorpay checkout"})
    const firstKey=new Headers(writes()[0]![1]?.headers).get("Idempotency-Key")
    current=purchase("delivered",4);fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByText(/^Credits delivered:/);fireEvent.click(await buyButton())
    await waitFor(()=>expect(writes()).toHaveLength(2))
    expect(new Headers(writes()[1]![1]?.headers).get("Idempotency-Key")).not.toBe(firstKey)
  })
  it("after uncertain checkout recovered and delivered through GET permits a new purchase with a fresh key",async()=>{
    createFailure=true;mount();fireEvent.click(await buyButton());await screen.findByText("Provider response unconfirmed")
    const firstKey=new Headers(writes()[0]![1]?.headers).get("Idempotency-Key")
    current=purchase();fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByRole("link",{name:"Continue extra-credit Razorpay checkout"});expect(writes()).toHaveLength(1)
    current=purchase("delivered",4);fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByText(/^Credits delivered:/);createFailure=false;fireEvent.click(await buyButton())
    await waitFor(()=>expect(writes()).toHaveLength(2))
    expect(new Headers(writes()[1]![1]?.headers).get("Idempotency-Key")).not.toBe(firstKey)
  })
  it.each(["admin","viewer"] as const)("%s cannot purchase or refresh credits",async role=>{
    act(()=>installLiveWorkspaceSession(role));current=purchase();mount()
    const buy=await screen.findByRole("button",{name:"Prepare extra-credit checkout"})
    expect((buy as HTMLButtonElement).disabled).toBe(true);fireEvent.click(buy)
    if(role==="admin")expect((await screen.findByRole("button",{name:"Check extra-credit payment"}) as HTMLButtonElement).disabled).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it("shows empty history and blocks checkout when history cannot be verified",async()=>{
    mount();await screen.findByText("No extra-credit purchases yet.")
    historyFailure=true;fireEvent.click(screen.getByRole("button",{name:"Reload extra-credit purchases"}))
    await screen.findByText("Extra-credit purchase history unavailable. Reload to try again.")
    expect((screen.getByRole("button",{name:"Prepare extra-credit checkout"}) as HTMLButtonElement).disabled).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it("configured pricing absent or no paid subscription makes checkout explicitly unavailable",async()=>{
    mount({...plan,commercial:null});await screen.findByText("Extra-credit checkout is unavailable until your active paid plan has configured credit prices.")
    expect(screen.queryByRole("button",{name:"Prepare extra-credit checkout"})).toBeNull();cleanup()
    mount(plan,null);await screen.findByText("Extra-credit checkout is unavailable until your active paid plan has configured credit prices.")
    expect(writes()).toHaveLength(0)
  })
  it("demo never creates a paid price or payment claim",async()=>{
    mode.live=false;mount();await screen.findByText("Demo extra-credit checkout is unavailable. No paid price is configured.")
    await screen.findByText("No extra-credit purchases yet.");expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(["javascript:alert(1)","https://rzp.io.evil.test/pay"])("unsafe provider URL %s cannot become a checkout link",async url=>{
    current={...purchase(),checkoutUrl:url};mount();await screen.findByText("Extra-credit purchase history unavailable. Reload to try again.")
    expect(screen.queryByRole("link",{name:"Continue extra-credit Razorpay checkout"})).toBeNull();expect(writes()).toHaveLength(0)
  })
})
