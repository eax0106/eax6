import type { EntitlementLimits } from "../entitlements/types";
import type { PlanCommercial } from "../entitlements/plan-commercial";
import type {
  PaymentMethodRef,
  Subscription,
} from "@alterx/shared-clients";

export interface BillingProfileRecord {
  tenantId: string;
  id: string;
  providerId: string;
  providerCustomerRef: string | null;
  subscriptionRef: string | null;
  status: string;
  currentPlan: string | null;
  createdAt: Date;
  updatedAt: Date;
  gstin?: string | null;
  commercialSnapshot?: PlanCommercial | null;
  providerPlanRef?: string | null;
  checkoutAttemptId?: string | null;
}

export interface BillingSubscriptionView extends Subscription {
  readonly version: string;
}

export interface CreateSubscriptionInput {
  plan_id: string;
  plan_version: string;
  gstin?: string;
}

export interface ConfiguredBillingPlanView {
  id: string;
  name: string;
  version: string;
  limits: EntitlementLimits;
  commercial: PlanCommercial | null;
  checkout: { basePriceMinor: number; gstPercent: 18; gstMinor: number; totalMinor: number;
    currency: "INR"; gatewayFeeMinor: 0 } | null;
}

export interface ChangeSubscriptionInput {
  plan_id: string;
}

export interface AttachPaymentMethodInput {
  provider_token: string;
}

export const billingDeferredCapabilities = [
  {
    capability: "overage_billing",
    status: "NOT_MET",
    reason: "Cost Ledger OUT-4 metered usage does not exist.",
  },
  {
    capability: "invoice_cost_ledger_reconciliation",
    status: "NOT_MET",
    reason: "Cost Ledger OUT-4 does not exist.",
  },
] as const;

export type BillingPaymentMethodView = PaymentMethodRef;
