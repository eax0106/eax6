import {QueryClient,QueryClientProvider} from "@tanstack/react-query"
import {cleanup,render,screen,waitFor} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import type {MarketplaceGovernanceItem} from "@alterx/contracts"
import type {MarketplaceListing} from "@/api/types"
vi.mock("@/api/client",()=>({api:{seller:{listings:{review:vi.fn(),update:vi.fn(),resubmit:vi.fn()}}}}))
import {api} from "@/api/client"
import {ListingReview} from "./listing-review"
const listing:MarketplaceListing={id:"lst_test",slug:"lst_test",title:"CRM mapping",shortDescription:"Mapping",description:"Old mapping",assetType:"workflow_template",category:"CRM",seller:{id:"seller",displayName:"Seller"},pricing:{type:"free"},tags:[],status:"needs_changes",createdAt:"2026-10-05T00:00:00Z",updatedAt:"2026-10-05T00:00:00Z"}
const review:MarketplaceGovernanceItem={resource_type:"listing",id:listing.id,name:listing.title,description:listing.description,status:"needs_changes",tenant_id:null,trust_level:null,updated_at:listing.updatedAt,etag:'"revision-1"',
 review_notes:[{id:"mge_test",actor_type:"staff",actor_ref:"stf_review",action:"needs_changes",previous_status:"human_review",next_status:"needs_changes",reason:"Correct the field mapping",occurred_at:listing.updatedAt}]}
const service=api.seller.listings
function view(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return render(<QueryClientProvider client={client}><ListingReview listing={listing} onClose={vi.fn()}/></QueryClientProvider>)}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(service.review).mockResolvedValue(structuredClone(review))})
afterEach(cleanup)
describe("seller review corrections",()=>{
 it("shows reviewer notes, saves actual corrections then resubmits with the new revision",async()=>{
  view();expect(await screen.findByText("Correct the field mapping")).toBeTruthy()
  const resubmit=screen.getByRole("button",{name:"Resubmit for review"});expect((resubmit as HTMLButtonElement).disabled).toBe(true)
  await userEvent.type(screen.getByRole("textbox",{name:"Correction reason"}),"Fixed CRM mapping")
  const title=screen.getByRole("textbox",{name:"Listing name"});await userEvent.clear(title);await userEvent.type(title,"Corrected CRM mapping")
  expect((resubmit as HTMLButtonElement).disabled).toBe(true)
  const updated={...review,name:"Corrected CRM mapping",etag:'"revision-2"'};vi.mocked(service.update).mockResolvedValue(updated);vi.mocked(service.review).mockResolvedValue(updated)
  await userEvent.click(screen.getByRole("button",{name:"Save corrections"}))
  await waitFor(()=>expect(service.update).toHaveBeenCalledWith("lst_test",{title:"Corrected CRM mapping",description:"Old mapping",reason:"Fixed CRM mapping",etag:'"revision-1"'}))
  await waitFor(()=>expect((resubmit as HTMLButtonElement).disabled).toBe(false))
  vi.mocked(service.resubmit).mockResolvedValue({...updated,status:"submitted",etag:'"revision-3"'});vi.mocked(service.review).mockResolvedValue({...updated,status:"submitted",etag:'"revision-3"'})
  await userEvent.click(resubmit);await waitFor(()=>expect(service.resubmit).toHaveBeenCalledWith("lst_test","Fixed CRM mapping",'"revision-2"'))
  expect(await screen.findByText("Status: submitted")).toBeTruthy();expect(screen.queryByRole("button",{name:"Resubmit for review"})).toBeNull()
 })
 it("preserves failed correction input and reason; reload is explicit",async()=>{
  vi.mocked(service.update).mockRejectedValue(new Error("Resource changed; reload review"));view();const title=await screen.findByRole("textbox",{name:"Listing name"})
  await userEvent.clear(title);await userEvent.type(title,"My correction");await userEvent.type(screen.getByRole("textbox",{name:"Correction reason"}),"Mapping fixed")
  await userEvent.click(screen.getByRole("button",{name:"Save corrections"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","Resource changed; reload review")
  expect((title as HTMLInputElement).value).toBe("My correction");expect((screen.getByRole("textbox",{name:"Correction reason"}) as HTMLTextAreaElement).value).toBe("Mapping fixed")
  expect(service.resubmit).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:"Reload review"})).toBeTruthy()
 })
 it("reports unavailable review and failed resubmission without changing status",async()=>{
  vi.mocked(service.review).mockRejectedValueOnce(new Error("Review unavailable"));view();expect(await screen.findByRole("alert")).toHaveProperty("textContent","Review unavailable");cleanup()
  vi.mocked(service.review).mockResolvedValue(review);vi.mocked(service.resubmit).mockRejectedValue(new Error("Audit unavailable"));view()
  await userEvent.type(await screen.findByRole("textbox",{name:"Correction reason"}),"Fixed mapping")
  await userEvent.click(screen.getByRole("button",{name:"Resubmit for review"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","Audit unavailable")
  expect(screen.getByText("Status: needs changes")).toBeTruthy();expect((screen.getByRole("textbox",{name:"Correction reason"}) as HTMLTextAreaElement).value).toBe("Fixed mapping")
 })
})
