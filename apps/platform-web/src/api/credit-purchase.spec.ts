import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mode = vi.hoisted(()=>({live:true}))
vi.mock("./http",async original=>({...await original<typeof import("./http")>(),get isLiveApi(){return mode.live}}))
import { billingService } from "./services/billing"

const id = "cpx_019a3258-1000-7000-8000-000000000001"
const otherId = "cpx_019a3258-1000-7000-8000-000000000002"
const version = "2026-10-05T00:00:00.000Z"
const input = {credits:10,plan_version:version,gstin:"27ABCDE1234F1Z5"}
const view = {id,quote:{planId:"basic",planVersion:version,credits:10,unitPriceMinor:50,creditsPerVerifiedRun:2,
  basePriceMinor:500,gstPercent:18,gstMinor:90,totalMinor:590,currency:"INR",gatewayFeeMinor:0},
  gstin:input.gstin,state:"checkout_ready",checkoutUrl:"https://rzp.io/i/credit-checkout",createdAt:version,updatedAt:version,revision:2}
const etag = `"credit-purchase-${id}-2"`
const fetcher = vi.fn<typeof fetch>()
beforeEach(()=>{mode.live=true;fetcher.mockReset();vi.stubGlobal("fetch",fetcher)})
afterEach(()=>vi.unstubAllGlobals())
const respond = (body:unknown=view,tag:string|undefined=etag)=>fetcher.mockImplementation(async()=>Response.json(body,{headers:tag?{ETag:tag}:{}}))

describe("extra-credit HTTP client",()=>{
  it("sends configured quantity, version, GSTIN and caller's stable request key with session cookies",async()=>{
    respond();const result=await billingService.createCreditPurchase(input,"credit-purchase-stable-key")
    expect(result).toEqual({...view,etag})
    const [url,init]=fetcher.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/billing/credit-purchases")
    expect(init?.method).toBe("POST");expect(init?.credentials).toBe("include")
    expect(JSON.parse(String(init?.body))).toEqual(input)
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("credit-purchase-stable-key")
  })
  it("refreshes only named purchase using displayed wire revision and strict empty body",async()=>{
    respond();const current=await billingService.getCreditPurchase(id)
    await billingService.refreshCreditPurchase(id,current.etag)
    const [url,init]=fetcher.mock.calls[1]!
    expect(String(url)).toContain(`${id}/refresh`)
    expect(init?.method).toBe("POST");expect(JSON.parse(String(init?.body))).toEqual({})
    expect(new Headers(init?.headers).get("If-Match")).toBe(etag)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([undefined,'"different"'])("rejects missing or mismatched wire ETag %s",async tag=>{
    fetcher.mockResolvedValue(Response.json(view,{headers:tag?{ETag:tag}:{}}))
    await expect(billingService.getCreditPurchase(id)).rejects.toThrow("Purchase revision unavailable")
  })
  it("rejects a different named purchase without offering it as current",async()=>{
    respond({...view,id:otherId},`"credit-purchase-${otherId}-2"`)
    await expect(billingService.getCreditPurchase(id)).rejects.toThrow("does not match the requested purchase")
  })
  it.each([
    {...view,quote:{...view.quote,credits:12,basePriceMinor:600,gstMinor:108,totalMinor:708}},
    {...view,quote:{...view.quote,planVersion:"2026-10-04T00:00:00.000Z"}},
    {...view,gstin:null},
  ])("rejects a create acknowledgement for a different quantity, price version or GSTIN",async body=>{
    respond(body);await expect(billingService.createCreditPurchase(input,"credit-purchase-stable-key")).rejects.toThrow("does not match the requested credits")
  })
  it.each(["https://rzp.io.evil.test/pay","https://user:pass@rzp.io/pay","https://rzp.io/pay#secret","javascript:alert(1)"])("rejects unsafe checkout %s",async url=>{
    respond({...view,checkoutUrl:url});await expect(billingService.getCreditPurchase(id)).rejects.toThrow()
  })
  it("keeps malformed history and duplicate IDs visible as errors",async()=>{
    respond({items:[]});await expect(billingService.getCreditPurchases()).rejects.toThrow()
    respond([view,view]);await expect(billingService.getCreditPurchases()).rejects.toThrow("history is inconsistent")
    respond([view]);expect(await billingService.getCreditPurchases()).toEqual([view])
  })
  it("does not dispatch invalid quantities, foreign IDs, empty revisions or bad request keys",async()=>{
    await expect(billingService.createCreditPurchase({...input,credits:1.5},"credit-purchase-stable-key")).rejects.toThrow()
    await expect(billingService.createCreditPurchase(input,"bad")).rejects.toThrow("request key is invalid")
    await expect(billingService.getCreditPurchase("cpx_invalid")).rejects.toThrow()
    await expect(billingService.refreshCreditPurchase(id,"")).rejects.toThrow("Reload the current purchase")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("preserves provider uncertainty and stale revision errors without retries",async()=>{
    fetcher.mockResolvedValue(Response.json({detail:"Provider acknowledgement pending"},{status:502}))
    await expect(billingService.createCreditPurchase(input,"credit-purchase-stable-key")).rejects.toThrow("Provider acknowledgement pending")
    fetcher.mockResolvedValue(Response.json({detail:"Purchase revision changed"},{status:412}))
    await expect(billingService.refreshCreditPurchase(id,etag)).rejects.toThrow("Purchase revision changed")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it("demo exposes no paid checkout or invented history",async()=>{
    mode.live=false;expect(await billingService.getCreditPurchases()).toEqual([])
    await expect(billingService.createCreditPurchase(input,"credit-purchase-stable-key")).rejects.toThrow("Demo extra-credit checkout is unavailable")
    await expect(billingService.getCreditPurchase(id)).rejects.toThrow("Demo extra-credit checkout is unavailable")
    await expect(billingService.refreshCreditPurchase(id,etag)).rejects.toThrow("Demo extra-credit checkout is unavailable")
    expect(fetcher).not.toHaveBeenCalled()
  })
})
