import { Inject, Injectable } from "@nestjs/common";
import type {
  BillingProvider,
  Invoice,
  Page,
  PaymentMethodRef,
  Subscription,
} from "@alterx/shared-clients";
import { checkoutAmounts } from "../entitlements/plan-commercial";
import { PLAN_DEFINITION_STORE, type PlanDefinitionStore } from "../entitlements/plan-definition-store";
import { BillingRepository } from "./billing.repository";
import { BillingHttpError } from "./problem";
import { BILLING_PROVIDER } from "./tokens";
import type {
  AttachPaymentMethodInput,
  BillingSubscriptionView,
  ChangeSubscriptionInput,
  CreateSubscriptionInput,
  ConfiguredBillingPlanView,
} from "./types";

@Injectable()
export class BillingService {
  constructor(
    private readonly repository: BillingRepository,
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProvider,
    @Inject(PLAN_DEFINITION_STORE) private readonly definitions: PlanDefinitionStore,
  ) {}

  async listPlans(): Promise<ConfiguredBillingPlanView[]> {
    return (await this.definitions.list()).map(definition => ({
      id: definition.plan, name: definition.plan, version: definition.updatedAt.toISOString(),
      limits: definition.limits, commercial: definition.commercial ?? null,
      checkout: checkoutAmounts(definition.commercial),
    }));
  }

  async getSubscription(
    tenantId: string,
  ): Promise<BillingSubscriptionView | null> {
    const instance = "/api/v1/billing/subscription";
    let profile = await this.repository.getProfile(tenantId);
    if (profile?.checkoutAttemptId) {
      const recovered = profile.providerPlanRef && this.provider.findCheckoutSubscription
        ? await this.provided(instance, () => this.provider.findCheckoutSubscription!(tenantId, {
          checkoutAttemptId: profile!.checkoutAttemptId!, providerPlanId: profile!.providerPlanRef!,
          createdAfter: (profile!.checkoutStartedAt ?? profile!.updatedAt).toISOString(),
        })) : null;
      if (!recovered) throw new BillingHttpError(503,"BILLING_CHECKOUT_UNCONFIRMED",
        "Checkout setup has not been confirmed; refresh its status before trying another purchase",instance);
      profile = await this.repository.finishCheckout(tenantId,"system:checkout-recovery",profile.checkoutAttemptId,recovered);
    }
    if (!profile?.subscriptionRef) return null;
    const subscription = await this.provided(instance, () => this.provider.getSubscription(tenantId));
    if (!subscription || subscription.id !== profile.subscriptionRef ||
        (profile.providerPlanRef && subscription.planId !== profile.providerPlanRef && subscription.planId !== profile.pendingProviderPlanRef)) {
      throw new BillingHttpError(502,"BILLING_PROFILE_INCONSISTENT","Billing profile is inconsistent",instance);
    }
    return profileView(subscription,profile);
  }

  async createSubscription(
    tenantId: string,
    input: CreateSubscriptionInput,
    actorRef: string,
  ): Promise<BillingSubscriptionView> {
    const instance = "/api/v1/billing/subscription";
    const definition = await this.definitions.find(input.plan_id);
    const amounts = checkoutAmounts(definition?.commercial);
    if (!definition || !amounts || !definition.commercial?.razorpayPlanId) {
      throw new BillingHttpError(503,"BILLING_PLAN_UNCONFIGURED","Plan checkout is unavailable until its launch configuration is set",instance);
    }
    if (definition.updatedAt.toISOString() !== input.plan_version) {
      throw new BillingHttpError(412,"BILLING_PLAN_CHANGED","Plan changed; review the current price before checkout",instance);
    }
    if (!this.provider.createCheckoutSubscription) {
      throw new BillingHttpError(503,"BILLING_CHECKOUT_UNAVAILABLE","Hosted subscription checkout is unavailable",instance);
    }
    const attemptId = await this.repository.claimCheckout(tenantId,actorRef,definition,input.gstin);
    try {
      const subscription = await this.provided(instance, () => this.provider.createCheckoutSubscription!(tenantId,
        definition.commercial!.razorpayPlanId!, { internalPlanId: definition.plan, checkoutAttemptId: attemptId,
          expectedTotalMinor: amounts.totalMinor, currency: amounts.currency, ...(input.gstin ? { gstin: input.gstin } : {}) }));
      const profile = await this.repository.finishCheckout(tenantId,actorRef,attemptId,subscription);
      return view({ ...subscription, planId: definition.plan, status: profile.status as Subscription["status"] },profile.updatedAt);
    } catch (error) {
      await this.repository.failCheckout(tenantId,actorRef,attemptId);
      throw error;
    }
  }

  async changeSubscription(
    tenantId: string,
    input: ChangeSubscriptionInput,
    actorRef: string,
    ifMatch: string | undefined,
  ): Promise<BillingSubscriptionView> {
    const instance = "/api/v1/billing/subscription";
    const definition=await this.definitions.find(input.plan_id),amounts=checkoutAmounts(definition?.commercial);
    if (!definition || !amounts || !definition.commercial?.razorpayPlanId) throw new BillingHttpError(503,"BILLING_PLAN_UNCONFIGURED","Plan checkout is unavailable until its launch configuration is set",instance);
    if (definition.updatedAt.toISOString()!==input.plan_version) throw new BillingHttpError(412,"BILLING_PLAN_CHANGED","Plan changed; review its current price",instance);
    if (!this.provider.changeConfiguredSubscription) throw new BillingHttpError(503,"BILLING_CHANGE_UNAVAILABLE","Configured subscription changes are unavailable",instance);
    const claim=await this.repository.claimMutation(tenantId,actorRef,"change",ifMatch,definition);
    const subscription=await this.provided(instance,()=>this.provider.changeConfiguredSubscription!(tenantId,claim.subscriptionRef!,definition.commercial!.razorpayPlanId!,
      {internalPlanId:definition.plan,expectedTotalMinor:amounts.totalMinor,currency:amounts.currency}));
    const profile=await this.repository.confirmMutationResponse(tenantId,actorRef,claim.mutationAttemptId!,subscription);
    return profileView(subscription,profile);
  }

  async cancelSubscription(
    tenantId: string,
    actorRef: string,
    ifMatch: string | undefined,
  ): Promise<BillingSubscriptionView> {
    const instance = "/api/v1/billing/subscription";
    const claim=await this.repository.claimMutation(tenantId,actorRef,"cancel",ifMatch);
    const subscription = await this.provided(instance, () =>
      this.provider.cancelSubscription(tenantId),
    );
    const profile=await this.repository.confirmMutationResponse(tenantId,actorRef,claim.mutationAttemptId!,subscription);
    return profileView(subscription,profile);
  }

  listInvoices(
    tenantId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<Invoice>> {
    return this.provided("/api/v1/billing/invoices", () =>
      this.provider.listInvoices(tenantId, cursor, limit),
    );
  }

  attachPaymentMethod(
    tenantId: string,
    input: AttachPaymentMethodInput,
  ): Promise<PaymentMethodRef> {
    return this.provided("/api/v1/billing/payment-methods", () =>
      this.provider.attachPaymentMethod(tenantId, input.provider_token),
    );
  }

  listPaymentMethods(tenantId: string): Promise<PaymentMethodRef[]> {
    return this.provided("/api/v1/billing/payment-methods", () =>
      this.provider.listPaymentMethods(tenantId),
    );
  }

  detachPaymentMethod(tenantId: string, ref: string): Promise<void> {
    return this.provided(
      `/api/v1/billing/payment-methods/${encodeURIComponent(ref)}`,
      () => this.provider.detachPaymentMethod(tenantId, ref),
    );
  }

  private async provided<T>(
    instance: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new BillingHttpError(
        502,
        "BILLING_PROVIDER_ERROR",
        "Billing provider operation failed",
        instance,
      );
    }
  }
}

function view(
  subscription: Subscription,
  updatedAt: Date,
): BillingSubscriptionView {
  return { ...subscription, version: updatedAt.toISOString() };
}

function profileView(subscription: Subscription, profile: import("./types").BillingProfileRecord): BillingSubscriptionView {
  return {...view({...subscription,planId:profile.currentPlan??subscription.planId,status:profile.status as Subscription["status"]},profile.updatedAt),
    ...(profile.mutationKind ? {pendingOperation:profile.mutationKind}:{}),...(profile.pendingPlan?{pendingPlan:profile.pendingPlan}:{})};
}
