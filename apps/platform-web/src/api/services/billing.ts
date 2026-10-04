import { apiDelete,apiGet, apiGetWithEtag, apiPatch, apiPost, isLiveApi, mutationKey } from "../http"
import type { BillingCreditBalance,BillingPaymentMethod, BillingPlan, BillingSubscription, Invoice } from "../types"

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

export const billingService = {
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
