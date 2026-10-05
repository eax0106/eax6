import {describe,expect,it,vi} from "vitest"
vi.mock("./http",async original=>({...await original<typeof import("./http")>(),isLiveApi:false}))
import {marketplaceService} from "./services/marketplace"
import {sellerService} from "./services/seller"
import {billingService} from "./services/billing"
describe("truthful v1 demo commerce",()=>{
 it("never lists, sells or installs paid mock assets",async()=>{
  const listings=await marketplaceService.listings.list()
  expect(listings.length).toBeGreaterThan(0);expect(listings.every(row=>row.pricing.type==="free")).toBe(true)
  expect(await marketplaceService.install(listings[0]!.id)).toEqual({success:true})
  await expect(marketplaceService.listings.get("mkt_2")).rejects.toThrow("not found")
  await expect(marketplaceService.install("mkt_2")).rejects.toThrow("not found")
  await expect(marketplaceService.purchase("mkt_2")).rejects.toThrow("free-only")
  await expect(sellerService.listings.create({pricing:{type:"paid"}})).rejects.toThrow("free-only")
  await expect(sellerService.listings.update("mkt_1",{title:"Paid",description:"Asset",reason:"Changed",pricing:{type:"paid",price:1,currency:"INR"}})).rejects.toThrow("free-only")
 })
 it("exposes unconfigured paid pricing without an invented subscription or charge",async()=>{
  expect(await billingService.getSubscription()).toBeNull()
  expect((await billingService.getPlans()).filter(plan=>plan.id!=="free").every(plan=>plan.checkout===null)).toBe(true)
  await expect(billingService.subscribe("pro","demo")).rejects.toThrow("no launch configuration")
  expect(await billingService.getInvoices()).toEqual([])
 })
})
