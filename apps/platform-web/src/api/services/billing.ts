import { apiGet, apiGetWithEtag, apiPatch, apiPost, isLiveApi, mutationKey } from "../http"
import type { BillingPaymentMethod, BillingPlan, BillingSubscription, Invoice } from "../types"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mockPlans: BillingPlan[] = [
  { id: "plan_free", name: "Free", description: "Demo free plan", amount: 0, currency: "INR", interval: 1, period: "monthly", active: true },
  { id: "plan_pro", name: "Pro", description: "Demo paid plan", amount: 4900, currency: "INR", interval: 1, period: "monthly", active: true },
]
let mockPlanId = "plan_pro"
const mockInvoices: Invoice[] = [
  { id: "inv_demo_1", subscriptionId: "sub_demo", status: "paid", amount: 4900, currency: "INR", issuedAt: "2026-08-01T00:00:00Z", paidAt: "2026-08-01T00:00:00Z" },
]
const mockPaymentMethod: BillingPaymentMethod = { ref: "pm_demo", type: "card", brand: "Visa", last4: "4242" }

interface InvoicePage { items: Invoice[]; nextCursor: string | null }

export const billingService = {
  getSubscription: async (): Promise<BillingSubscription | null> => {
    if (isLiveApi) return apiGet<BillingSubscription | null>("/api/v1/billing/subscription")
    await delay(300)
    return {
      id: "sub_demo", tenantId: "ten_demo", planId: mockPlanId, status: "active",
      currentPeriodStart: "2026-08-01T00:00:00Z", currentPeriodEnd: "2026-09-01T00:00:00Z",
      providerCustomerRef: null, version: "demo",
    }
  },
  getPlans: async (): Promise<BillingPlan[]> => {
    if (isLiveApi) return apiGet<BillingPlan[]>("/api/v1/billing/plans")
    await delay(300)
    return mockPlans
  },
  changePlan: async (planId: string): Promise<BillingSubscription> => {
    if (isLiveApi) {
      const current = await apiGetWithEtag<BillingSubscription | null>("/api/v1/billing/subscription")
      if (!current.data || !current.etag) throw new Error("An existing subscription with a server ETag is required to change plans")
      return apiPatch<BillingSubscription>("/api/v1/billing/subscription", { plan_id: planId }, {
        ifMatch: current.etag,
        idempotencyKey: mutationKey("billing-plan-change"),
      })
    }
    await delay(600)
    mockPlanId = planId
    return (await billingService.getSubscription())!
  },
  /** Starts a subscription (task B2.8): the tenant has none yet and pays with a registered method. */
  subscribe: async (planId: string, paymentMethodRef: string): Promise<BillingSubscription> => {
    if (isLiveApi) {
      return apiPost<BillingSubscription>("/api/v1/billing/subscription", { plan_id: planId, payment_method_ref: paymentMethodRef }, {
        idempotencyKey: mutationKey("billing-subscribe"),
      })
    }
    await delay(600)
    mockPlanId = planId
    return (await billingService.getSubscription())!
  },
  getInvoices: async (): Promise<Invoice[]> => {
    if (isLiveApi) {
      const page = await apiGet<InvoicePage>("/api/v1/billing/invoices?limit=50")
      return page.items
    }
    await delay(400)
    return mockInvoices
  },
  getPaymentMethod: async (): Promise<BillingPaymentMethod | null> => {
    if (isLiveApi) {
      const methods = await apiGet<BillingPaymentMethod[]>("/api/v1/billing/payment-methods")
      return methods[0] ?? null
    }
    await delay(300)
    return mockPaymentMethod
  },
  updatePaymentMethod: async (_data: unknown): Promise<void> => {
    if (isLiveApi) throw new Error("Tokenized payment method setup is not available in this screen")
    await delay(1000)
  },
}
