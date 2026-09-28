import type { ProviderCapabilities } from "@alterx/contracts";
import { createMockProvider } from "../mock-provider";
import type {
  BillingEvent,
  BillingDispute,
  BillingPlan,
  BillingProvider,
  Invoice,
  PaymentMethodRef,
  ProviderMetadata,
  Subscription,
} from "../provider-types";
import { mockCapabilities, mockMetadata } from "./shared";

export const MOCK_BILLING_CAPABILITIES: ProviderCapabilities =
  mockCapabilities(65_536);

const plans: BillingPlan[] = [
  {
    id: "plan_contract",
    name: "Contract",
    description: "Billing contract fixture",
    amount: 1_000,
    currency: "INR",
    interval: 1,
    period: "monthly",
    active: true,
  },
];

export interface MockBillingProviderOptions {
  readonly providerId?: string;
  readonly metadata?: ProviderMetadata<"BillingProvider">;
  readonly capabilities?: ProviderCapabilities;
}

export function createMockBillingProvider(
  options: MockBillingProviderOptions = {},
): BillingProvider {
  const providerId = options.providerId ?? "mock.billing";
  const subscriptions = new Map<string, Subscription>();
  const paymentMethods = new Map<string, PaymentMethodRef[]>();

  return createMockProvider<BillingProvider>({
    metadata:
      options.metadata ?? mockMetadata(providerId, "BillingProvider"),
    capabilities: options.capabilities ?? MOCK_BILLING_CAPABILITIES,
    implementation: {
      listPlans: async () => plans,
      getSubscription: async (tenantId) =>
        subscriptions.get(tenantId) ?? null,
      createSubscription: async (tenantId, planId) => {
        const subscription = subscriptionFixture(tenantId, planId, "active");
        subscriptions.set(tenantId, subscription);
        return subscription;
      },
      changeSubscription: async (tenantId, planId) => {
        const subscription = subscriptionFixture(tenantId, planId, "active");
        subscriptions.set(tenantId, subscription);
        return subscription;
      },
      cancelSubscription: async (tenantId) => {
        const current =
          subscriptions.get(tenantId) ??
          subscriptionFixture(tenantId, plans[0]!.id, "active");
        const cancelled = { ...current, status: "cancelled" as const };
        subscriptions.set(tenantId, cancelled);
        return cancelled;
      },
      listInvoices: async (_tenantId, cursor, limit = 50) => ({
        items: invoiceFixtures().slice(0, limit),
        nextCursor: cursor === undefined ? null : cursor,
      }),
      attachPaymentMethod: async (tenantId, providerToken) => {
        const method: PaymentMethodRef = {
          ref: providerToken,
          type: "card",
          brand: "visa",
          last4: "1111",
        };
        paymentMethods.set(tenantId, [
          ...(paymentMethods.get(tenantId) ?? []),
          method,
        ]);
        return method;
      },
      listPaymentMethods: async (tenantId) =>
        paymentMethods.get(tenantId) ?? [],
      detachPaymentMethod: async (tenantId, ref) => {
        paymentMethods.set(
          tenantId,
          (paymentMethods.get(tenantId) ?? []).filter(
            (method) => method.ref !== ref,
          ),
        );
      },
      refundPayment: async (paymentRef, amountMinor, speed) => ({
        id: `rfnd_${paymentRef}`,
        paymentRef,
        amount: amountMinor,
        currency: "INR",
        status: "processed",
        speed,
        createdAt: "2026-07-28T00:02:00.000Z",
      }),
      resolveDispute: async (disputeRef, resolution): Promise<BillingDispute> => ({
        id: disputeRef,
        paymentRef: "pay_contract",
        amount: 1_000,
        currency: "INR",
        status: resolution.action === "accept" ? "lost" : "under_review",
        phase: "chargeback",
        respondBy: "2026-08-28T00:00:00.000Z",
      }),
      verifyWebhookSignature: (rawBody, signature, secret) =>
        signature === `${secret}:${new TextDecoder().decode(rawBody)}`,
      parseWebhookEvent: (rawBody): BillingEvent =>
        JSON.parse(new TextDecoder().decode(rawBody)) as BillingEvent,
    },
  });
}

function subscriptionFixture(
  tenantId: string,
  planId: string,
  status: Subscription["status"],
): Subscription {
  return {
    id: `sub_${tenantId}`,
    tenantId,
    planId,
    status,
    currentPeriodStart: "2026-07-28T00:00:00.000Z",
    currentPeriodEnd: "2026-08-28T00:00:00.000Z",
    providerCustomerRef: `cust_${tenantId}`,
  };
}

function invoiceFixtures(): Invoice[] {
  return [
    {
      id: "inv_contract",
      subscriptionId: "sub_contract",
      amount: 1_000,
      currency: "INR",
      status: "paid",
      issuedAt: "2026-07-28T00:00:00.000Z",
      paidAt: "2026-07-28T00:01:00.000Z",
      documentUrl: null,
    },
  ];
}
