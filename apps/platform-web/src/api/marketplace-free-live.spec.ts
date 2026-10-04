import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
vi.mock("./http",async original=>({...await original<typeof import("./http")>(),isLiveApi:true}))
import { marketplaceService } from "./services/marketplace"
import { sellerService } from "./services/seller"
const fetcher=vi.fn<typeof fetch>()
const free={id:"lst_free",tenantId:"ten_publisher",type:"workflow_template",name:"Free fixture",description:"Template",latestVersion:"1.0.0",status:"published",priceMinor:"0",createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z"}
const paid={...free,id:"lst_paid",priceMinor:"100"}
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal("fetch",fetcher)})
afterEach(()=>vi.unstubAllGlobals())
describe("free-only marketplace client",()=>{
 it("lists free assets only and refuses direct paid detail and install without issuing any writes",async()=>{
  fetcher.mockResolvedValueOnce(Response.json({data:[free,paid]})).mockImplementation(async()=>Response.json(paid))
  expect((await marketplaceService.listings.list()).map(row=>row.id)).toEqual([free.id])
  await expect(marketplaceService.listings.get(paid.id)).rejects.toThrow("free-only")
  await expect(marketplaceService.install(paid.id)).rejects.toThrow()
  expect(fetcher.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true)
 })
 it("installs a free published version only after server compatibility succeeds",async()=>{
  fetcher.mockResolvedValueOnce(Response.json(free)).mockResolvedValueOnce(Response.json([{id:"lsv_free",version:"1.0.0",publishedAt:free.createdAt}]))
   .mockResolvedValueOnce(Response.json({compatible:true})).mockResolvedValueOnce(Response.json({id:"ins_free"}))
  expect(await marketplaceService.install(free.id)).toEqual({success:true})
  const [url,init]=fetcher.mock.calls[3]!
  expect(url).toBe(`/api/v1/marketplace/listings/${free.id}/actions/install`)
  expect(JSON.parse(String(init?.body))).toEqual({listing_version_id:"lsv_free",confirmed:true})
  expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^marketplace-install/)
 })
 it("omits unavailable legacy search results while retaining free hits and surfacing actual API errors",async()=>{
  fetcher.mockImplementation(async url=>String(url).startsWith("/api/v1/search")?Response.json({data:[{id:free.id},{id:paid.id}]}):String(url).endsWith(paid.id)?Response.json({detail:"Unavailable"},{status:404}):Response.json(free))
  expect((await marketplaceService.search("fixture")).map(row=>row.id)).toEqual([free.id])
  fetcher.mockImplementation(async url=>String(url).startsWith("/api/v1/search")?Response.json({data:[{id:free.id}]}):Response.json({detail:"Catalog unavailable"},{status:503}))
  await expect(marketplaceService.search("fixture")).rejects.toThrow("Catalog unavailable")
 })
 it("rejects paid seller drafts and all purchase calls before network access",async()=>{
  await expect(sellerService.listings.create({title:"Paid",pricing:{type:"paid",price:1}})).rejects.toThrow("free-only")
  await expect(marketplaceService.purchase(free.id)).rejects.toThrow("free-only")
  expect(fetcher).not.toHaveBeenCalled()
 })
})
