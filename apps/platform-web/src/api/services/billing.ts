import { CreditPurchaseIdSchema, CreditPurchaseViewSchema, CreateCreditPurchaseSchema, type CreateCreditPurchase } from "@alterx/contracts"
import { apiDelete,apiGet, apiGetWithEtag, apiPatch, apiPost, isLiveApi, mutationKey } from "../http"
import type { BillingCreditPurchase,BillingCreditBalance,BillingPaymentMethod, BillingPlan, BillingSubscription, Invoice } from "../types"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const mockPlans: BillingPlan[] = [
  {id:"free",name:"Free",version:"demo",limits:{maxRunsPerDay:10},commercial:null,checkout:null},
  {id:"basic",name:"Basic",version:"demo",limits:{maxRunsPerDay:25},commercial:null,checkout:null},
  {id:"pro",name:"Pro",version:"demo",limits:{maxRunsPerDay:100},commercial:null,checkout:null},
]
interface InvoicePage { items: Invoice[]; nextCursor: string | null }
function requiredEtag(etag:string|undefined):string {
  if(!etag)throw new Error("Refresh the current subscription before changing it")
  return etag
}

const purchasePath = "/api/v1/billing/credit-purchases"
function purchaseResult(raw: unknown, etag: string | undefined, id?: string): BillingCreditPurchase {
  const purchase = CreditPurchaseViewSchema.parse(raw)
  if (id && purchase.id !== id) throw new Error("Purchase confirmation does not match the requested purchase")
  if (etag !== `"credit-purchase-${purchase.id}-${purchase.revision}"`) throw new Error("Purchase revision unavailable; reload its current status")
  return {...purchase, etag}
}
async function purchasePost(path: string, body: unknown, options: {idempotencyKey?: string; ifMatch?: string}, id?: string) {
  let etag: string | undefined
  const raw = await apiPost<unknown>(path, body, {...options, onResponse: response => {etag = response.headers.get("etag") ?? undefined}})
  return purchaseResult(raw, etag, id)
}

export const billingService = {
  getCreditPurchases: async () => {
    if (!isLiveApi) return []
    const purchases = CreditPurchaseViewSchema.array().max(50).parse(await apiGet<unknown>(purchasePath))
    if (new Set(purchases.map(purchase=>purchase.id)).size !== purchases.length) throw new Error("Purchase history is inconsistent; reload billing status")
    return purchases
  },
  getCreditPurchase: async (id: string): Promise<BillingCreditPurchase> => {
    if (!isLiveApi) throw new Error("Demo extra-credit checkout is unavailable")
    CreditPurchaseIdSchema.parse(id)
    const result = await apiGetWithEtag<unknown>(`${purchasePath}/${encodeURIComponent(id)}`)
    return purchaseResult(result.data, result.etag, id)
  },
  createCreditPurchase: async (input: CreateCreditPurchase, key: string): Promise<BillingCreditPurchase> => {
    if (!isLiveApi) throw new Error("Demo extra-credit checkout is unavailable")
    const body = CreateCreditPurchaseSchema.parse(input)
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("Purchase request key is invalid")
    const purchase = await purchasePost(purchasePath, body, {idempotencyKey:key})
    if (purchase.quote.credits !== body.credits || purchase.quote.planVersion !== body.plan_version || purchase.gstin !== (body.gstin ?? null)) {
      throw new Error("Purchase confirmation does not match the requested credits and price")
    }
    return purchase
  },
  refreshCreditPurchase: async (id: string, etag: string): Promise<BillingCreditPurchase> => {
    if (!isLiveApi) throw new Error("Demo extra-credit checkout is unavailable")
    CreditPurchaseIdSchema.parse(id)
    if (!etag) throw new Error("Reload the current purchase before refreshing payment status")
    return purchasePost(`${purchasePath}/${encodeURIComponent(id)}/refresh`, {}, {ifMatch:etag}, id)
  },
  getSubscription: async (): Promise<BillingSubscription | null> => {
    if (isLiveApi) {
      const result=await apiGetWithEtag<BillingSubscription|null>("/api/v1/billing/subscription")
      return result.data?{...result.data,etag:result.etag}:null
    }
    await delay(100);return null
  },
  getPlans: async (): Promise<BillingPlan[]> => {
    if (isLiveApi) return apiGet<BillingPlan[]>("/api/v1/billing/plans")
    await delay(100);return mockPlans
  },
  changePlan: async (planId: string,planVersion:string,etag:string|undefined): Promise<BillingSubscription> => {
    if (isLiveApi) return apiPatch<BillingSubscription>("/api/v1/billing/subscription", {plan_id:planId,plan_version:planVersion}, {
      ifMatch:requiredEtag(etag),idempotencyKey:mutationKey("billing-plan-change"),
    })
    throw new Error("Demo paid plans have no launch configuration")
  },
  subscribe: async (planId: string,planVersion:string,gstin?:string): Promise<BillingSubscription> => {
    if (isLiveApi) return apiPost<BillingSubscription>("/api/v1/billing/subscription", {
      plan_id:planId,plan_version:planVersion,...(gstin?{gstin}:{}),
    }, {idempotencyKey:mutationKey("billing-subscribe")})
    throw new Error("Demo paid plans have no launch configuration")
  },
  cancelSubscription:async(etag:string|undefined):Promise<BillingSubscription>=>{
    if(isLiveApi)return apiDelete<BillingSubscription>("/api/v1/billing/subscription",{
      ifMatch:requiredEtag(etag),idempotencyKey:mutationKey("billing-cancel"),
    })
    throw new Error("There is no demo subscription to cancel")
  },
  getCredits:async():Promise<BillingCreditBalance>=>{
    if(isLiveApi)return apiGet<BillingCreditBalance>("/api/v1/billing/credits")
    return {balance:"0",reserved:"0",available:"0"}
  },
  getInvoices: async (): Promise<Invoice[]> => {
    if (isLiveApi) return (await apiGet<InvoicePage>("/api/v1/billing/invoices?limit=50")).items
    await delay(100);return []
  },
  getPaymentMethod: async (): Promise<BillingPaymentMethod | null> => {
    if (isLiveApi) return (await apiGet<BillingPaymentMethod[]>("/api/v1/billing/payment-methods"))[0]??null
    await delay(100);return null
  },
  updatePaymentMethod: async (_data: unknown): Promise<void> => {
    throw new Error("Manage the subscription payment mandate through Razorpay hosted checkout")
  },
}
