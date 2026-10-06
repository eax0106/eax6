import { createHash } from "node:crypto";
import { TenantIdSchema } from "@alterx/contracts";
import { checkoutAmounts } from "../entitlements/plan-commercial";
import { BillingPolicyService } from "./billing-policy.service";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  BillingEvent,
  BillingProvider,
  JsonValue,
  SecretsProvider,
} from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import {
  CONFIG_PROVIDER,
  ENTITLEMENT_PROVIDER,
  type ConfigProvider,
  type EntitlementAccessState,
  type EntitlementProvider,
} from "../entitlements";
import { PgIdempotencyStore } from "../idempotency";
import { CreditPurchaseService, creditPurchaseEventContext } from "../credit-purchases/credit-purchase.service";
import { BillingWebhookRepository } from "./billing-webhook.repository";
import { BillingHttpError } from "./problem";
import {
  BILLING_PROVIDER,
  BILLING_SECRETS_PROVIDER,
  BILLING_WEBHOOK_SECRET_REF,
} from "./tokens";

const successEvents = new Set(["subscription.activated", "subscription.charged", "subscription.resumed"]);
const failedEvents = new Set(["subscription.pending", "subscription.halted", "subscription.paused"]);
const terminalEvents = new Set(["subscription.cancelled", "subscription.completed", "subscription.expired"]);
const terminalStates = new Set(["cancelled", "completed", "expired"]);

export interface BillingWebhookResult {
  accepted: true;
  event_id: string;
  state: EntitlementAccessState;
  replayed: boolean;
}

@Injectable()
export class BillingWebhookService {
  constructor(
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProvider,
    @Inject(BILLING_SECRETS_PROVIDER)
    private readonly secrets: SecretsProvider,
    @Inject(BILLING_WEBHOOK_SECRET_REF)
    private readonly webhookSecretRef: string,
    private readonly idempotency: PgIdempotencyStore,
    private readonly repository: BillingWebhookRepository,
    @Inject(ENTITLEMENT_PROVIDER)
    private readonly entitlements: EntitlementProvider,
    @Inject(CONFIG_PROVIDER)
    private readonly config: ConfigProvider,
    private readonly policy: BillingPolicyService,
    @Optional() private readonly creditPurchases?: CreditPurchaseService,
  ) {}

  private readonly now = (): Date => new Date();

  async receive(
    providerId: string,
    rawBody: Uint8Array,
    signature: string,
    providerEventId: string,
  ): Promise<BillingWebhookResult> {
    const instance = `/api/v1/billing/webhooks/${encodeURIComponent(providerId)}`;
    if (providerId !== this.provider.metadata.providerId) {
      throw new BillingHttpError(
        404,
        "BILLING_PROVIDER_NOT_FOUND",
        "Billing provider not found",
        instance,
      );
    }

    const secret = await this.getWebhookSecret(instance);
    if (
      !signature ||
      !this.provider.verifyWebhookSignature(rawBody, signature, secret)
    ) {
      throw new BillingHttpError(
        401,
        "BILLING_WEBHOOK_UNAUTHORIZED",
        "Webhook authentication failed",
        instance,
      );
    }

    if (!providerEventId) {
      throw new BillingHttpError(
        400,
        "BILLING_WEBHOOK_EVENT_ID_REQUIRED",
        "Webhook event id is required",
        instance,
      );
    }
    const event = {
      ...this.parseEvent(rawBody, instance),
      id: providerEventId,
    };
    if (event.type === "payment_link.paid") {
      const purchase = creditPurchaseEventContext(event.payload);
      if (purchase) {
        if (!this.creditPurchases) throw new BillingHttpError(503, "CREDIT_PURCHASE_UNAVAILABLE", "Credit purchase reconciliation is unavailable", instance);
        const tenantId = purchase.tenantId.slice(4);
        const result = await this.idempotency.execute({ tenantId, key: `${providerId}:${event.id}`,
          fingerprint: createHash("sha256").update(rawBody).digest("hex"), instance }, async () => {
          await this.creditPurchases!.paidNotification(purchase, event.id);
          const current = await this.repository.transaction(tenantId, tx => this.repository.getDunningState(tx, tenantId));
          return { status: 202, body: { accepted: true, event_id: event.id, state: current.state } };
        });
        return { ...result.body as Omit<BillingWebhookResult, "replayed">, replayed: result.replayed };
      }
    }
    if (!event.type.startsWith("subscription.")) {
      return { accepted: true, event_id: event.id, state: "active", replayed: false };
    }
    const context = eventContext(event, instance);
    const fingerprint = createHash("sha256").update(rawBody).digest("hex");
    const result = await this.idempotency.execute(
      {
        tenantId: context.tenantId,
        key: `${providerId}:${event.id}`,
        fingerprint,
        instance,
      },
      async () => ({
        status: 202,
        body: await this.process(providerId, event, context),
      }),
    );
    const body = result.body as Omit<BillingWebhookResult, "replayed">;
    return { ...body, replayed: result.replayed };
  }

  private async process(
    providerId: string,
    event: BillingEvent,
    context: EventContext,
  ): Promise<Omit<BillingWebhookResult, "replayed">> {
    return this.repository.transaction(context.tenantId, async (client) => {
      let profile = await this.repository.lockProfile(client, context.tenantId);
      const current = await this.repository.getDunningState(client, context.tenantId);
      if (profile?.checkout_attempt_id && !profile.subscription_ref &&
          profile.checkout_attempt_id === context.checkoutAttemptId && profile.provider_plan_ref === context.providerPlan) {
        await this.repository.bindCheckout(client,context.tenantId,context.subscriptionId,profile.checkout_attempt_id,context.providerPlan);
        profile = await this.repository.lockProfile(client,context.tenantId);
      }
      if (!profile?.subscription_ref || profile.checkout_attempt_id) {
        throw new BillingHttpError(503, "BILLING_CHECKOUT_UNCONFIRMED", "Subscription binding is not confirmed; retry delivery", "/api/v1/billing/webhooks/razorpay");
      }
      const inserted = await this.repository.insertEvent(client, {
        tenantId: context.tenantId, providerId, providerEventId: event.id,
        type: event.type, payload: sanitizePayload(event.payload),
      });
      if (!inserted) return { accepted: true, event_id: event.id, state: current.state };
      let next = current;
      // A signed receipt is not authority for a different persisted subscription.
      const pendingPlan = profile.subscription_ref === context.subscriptionId && profile.mutation_kind === "change" &&
        profile.pending_provider_plan_ref === context.providerPlan && profile.pending_plan && profile.pending_commercial_snapshot;
      const bound = profile.subscription_ref === context.subscriptionId && (profile.provider_plan_ref === context.providerPlan || Boolean(pendingPlan));
      const historical = bound ? null : await this.repository.historicalPlan(client,context.tenantId,context.subscriptionId,context.providerPlan);
      const commercial = pendingPlan ? profile.pending_commercial_snapshot : bound ? profile.commercial_snapshot : historical?.commercial_snapshot;
      const timestamp = Math.floor(new Date(event.createdAt).getTime() / 1000);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > Math.floor(this.now().getTime()/1000)+300) {
        throw new BillingHttpError(400,"BILLING_WEBHOOK_INVALID","Webhook timestamp is invalid","/api/v1/billing/webhooks/razorpay");
      }
      // Payment delivery can arrive after cancellation or a newer state event.
      // Its immutable captured payment earns credits without reopening access.
      if ((bound || historical) && successEvents.has(event.type)) {
        const expected = checkoutAmounts(commercial);
        if (!expected) throw new BillingHttpError(503,"BILLING_PLAN_UNCONFIGURED","Subscription configuration is unavailable","/api/v1/billing/webhooks/razorpay");
        if (context.payment) {
          if (!/^pay_[A-Za-z0-9]{1,100}$/.test(context.payment.id) || context.payment.status !== "captured" ||
              context.payment.amount !== expected.totalMinor || context.payment.currency !== expected.currency) {
            throw new BillingHttpError(400,"BILLING_PAYMENT_MISMATCH","Captured payment does not match configured subscription","/api/v1/billing/webhooks/razorpay");
          }
          const credits = commercial!.includedCredits!;
          if (credits > 0) await this.repository.enqueueCredits(client, context.tenantId, context.payment.id, credits, event.id);
          await this.policy.prepare(context.tenantId,client);
        } else if (event.type === "subscription.charged") {
          throw new BillingHttpError(400,"BILLING_PAYMENT_MISSING","Subscription charge needs its captured payment","/api/v1/billing/webhooks/razorpay");
        }
      }
      if (bound && timestamp >= Number(profile.last_provider_event_at) &&
          !(terminalStates.has(profile.status) && !terminalEvents.has(event.type))) {
        if(pendingPlan) {
          await this.repository.promotePendingPlan(client,context.tenantId,event.id);
          profile=(await this.repository.lockProfile(client,context.tenantId))!;
        }
        if (successEvents.has(event.type)) {
          if (!profile.current_plan || !checkoutAmounts(profile.commercial_snapshot)) {
            throw new BillingHttpError(503,"BILLING_PLAN_UNCONFIGURED","Subscription configuration is unavailable","/api/v1/billing/webhooks/razorpay");
          }
          next = await this.applySuccess(client, event, { ...context, plan: profile.current_plan }, current);
        } else if (failedEvents.has(event.type) && current.currentPlan && current.currentPlan !== "free") {
          next = await this.applyFailure(client, event, current, context.tenantId);
        } else if (terminalEvents.has(event.type)) {
          await this.entitlements.createEntitlement(context.tenantId,"free",client,{accessState:"active"});
          next = { state:"active", currentPlan:"free", firstFailedAt:null };
          await this.persistTransition(client, context.tenantId, event.id, current, next, event.type);
          await this.repository.clearMutation(client,context.tenantId);
        } else if (pendingPlan && event.type === "subscription.updated" && current.currentPlan && current.currentPlan !== "free") {
          await this.entitlements.createEntitlement(context.tenantId,profile.current_plan!,client,{accessState:current.state});
          next={...current,currentPlan:profile.current_plan};
          await this.persistTransition(client,context.tenantId,event.id,current,next,"subscription_plan_updated");
        }
        const status = context.subscriptionStatus;
        await this.repository.updateProviderState(client, context.tenantId, status, timestamp);
        await this.policy.prepare(context.tenantId,client);
      }

      await this.repository.markEventProcessed(
        client,
        context.tenantId,
        event.id,
      );
      return {
        accepted: true,
        event_id: event.id,
        state: next.state,
      };
    });
  }

  private async applySuccess(
    client: PoolClient,
    event: BillingEvent,
    context: EventContext,
    current: DunningState,
  ): Promise<DunningState> {
    const plan = context.plan ?? current.currentPlan;
    if (!plan) {
      throw new Error("Billing success event has no plan");
    }
    await this.entitlements.createEntitlement(
      context.tenantId,
      plan,
      client,
      { accessState: "active" },
    );
    const next: DunningState = {
      state: "active",
      currentPlan: plan,
      firstFailedAt: null,
    };
    await this.persistTransition(
      client,
      context.tenantId,
      event.id,
      current,
      next,
      "payment_succeeded",
    );
    return next;
  }

  private async applyFailure(
    client: PoolClient,
    event: BillingEvent,
    current: DunningState,
    tenantId: string,
  ): Promise<DunningState> {
    if (!current.currentPlan) {
      throw new Error("Billing failure event has no current plan");
    }
    const now = this.now();
    const config = await this.config.getDunningConfig();
    const firstFailedAt = current.firstFailedAt ?? new Date(event.createdAt);
    const elapsedSeconds = (now.getTime() - firstFailedAt.getTime()) / 1_000;
    const state: EntitlementAccessState =
      elapsedSeconds >= config.suspensionThresholdSeconds
          ? "suspended"
          : elapsedSeconds >= config.gracePeriodSeconds
            ? "limited"
            : "grace";
    const next: DunningState = {
      state,
      currentPlan: current.currentPlan,
      firstFailedAt,
    };

    if (state !== current.state) {
      await this.entitlements.createEntitlement(tenantId,current.currentPlan,client,{accessState:state});
    }
    if (state !== current.state) {
      await this.persistTransition(
        client,
        tenantId,
        event.id,
        current,
        next,
        "payment_failed",
      );
    }
    return next;
  }

  private async persistTransition(
    client: PoolClient,
    tenantId: string,
    eventId: string,
    current: DunningState,
    next: DunningState,
    reason: string,
  ): Promise<void> {
    await this.repository.saveDunningState(client, tenantId, next);
    await this.repository.auditTransition(client, {
      tenantId,
      providerEventId: eventId,
      fromState: current.state,
      toState: next.state,
      reason,
    });
  }

  private parseEvent(rawBody: Uint8Array, instance: string): BillingEvent {
    try {
      return this.provider.parseWebhookEvent(rawBody);
    } catch {
      throw new BillingHttpError(
        400,
        "BILLING_WEBHOOK_INVALID",
        "Webhook payload is invalid",
        instance,
      );
    }
  }

  private async getWebhookSecret(instance: string): Promise<string> {
    try {
      return await this.secrets.getSecret(this.webhookSecretRef);
    } catch {
      throw new BillingHttpError(
        502,
        "BILLING_WEBHOOK_SECRET_UNAVAILABLE",
        "Webhook verification is unavailable",
        instance,
      );
    }
  }
}

interface EventContext {
  tenantId: string;
  plan: string | null;
  subscriptionId: string;
  subscriptionStatus: string;
  providerPlan: string;
  checkoutAttemptId: string | null;
  payment: { id: string; status: string; amount: number; currency: string } | null;
}

type DunningState = {
  state: EntitlementAccessState;
  currentPlan: string | null;
  firstFailedAt: Date | null;
};

function eventContext(event: BillingEvent, instance: string): EventContext {
  const root = record(event.payload);
  const subscription = nestedEntity(root, "subscription");
  const payment = nestedEntity(root, "payment");
  const notes =
    recordOrUndefined(subscription?.notes) ??
    recordOrUndefined(payment?.notes) ??
    recordOrUndefined(root.notes);
  const tenantId = nonEmptyString(notes?.tenant_id ?? root.tenant_id);
  if (!tenantId) {
    throw new BillingHttpError(
      400,
      "BILLING_WEBHOOK_INVALID",
      "Webhook tenant context is missing",
      instance,
    );
  }
  const normalized = TenantIdSchema.safeParse(tenantId.startsWith("ten_") ? tenantId : `ten_${tenantId}`);
  const subscriptionId = nonEmptyString(subscription?.id), providerPlan = nonEmptyString(subscription?.plan_id), subscriptionStatus = nonEmptyString(subscription?.status);
  if (!normalized.success || !subscriptionId || !/^sub_[A-Za-z0-9]{1,100}$/.test(subscriptionId) ||
      !providerPlan || !/^plan_[A-Za-z0-9]{1,100}$/.test(providerPlan) || !subscriptionStatus ||
      !["created","authenticated","active","pending","halted","paused","cancelled","completed","expired"].includes(subscriptionStatus) ||
      (successEvents.has(event.type) && subscriptionStatus !== "active") ||
      (terminalEvents.has(event.type) && subscriptionStatus !== event.type.slice("subscription.".length))) {
    throw new BillingHttpError(400,"BILLING_WEBHOOK_INVALID","Subscription context is invalid",instance);
  }
  return { tenantId: normalized.data.slice(4), plan: null, subscriptionId, providerPlan, subscriptionStatus,
    checkoutAttemptId: nonEmptyString(notes?.alter_checkout_attempt),
    payment: payment ? { id: nonEmptyString(payment.id) ?? "", status: nonEmptyString(payment.status) ?? "",
      amount: typeof payment.amount === "number" ? payment.amount : NaN, currency: nonEmptyString(payment.currency) ?? "" } : null };

}

function nestedEntity(
  root: Record<string, JsonValue>,
  key: string,
): Record<string, JsonValue> | undefined {
  const wrapper = recordOrUndefined(root.payload)?.[key] ?? root[key];
  return recordOrUndefined(recordOrUndefined(wrapper)?.entity);
}

function record(value: JsonValue): Record<string, JsonValue> {
  return recordOrUndefined(value) ?? {};
}

function recordOrUndefined(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function nonEmptyString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const secretKeys = new Set([
  "card_number",
  "pan",
  "cvv",
  "cvc",
  "provider_token",
  "api_key",
  "secret",
]);

function sanitizePayload(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        secretKeys.has(key.toLowerCase())
          ? "[REDACTED]"
          : sanitizePayload(entry),
      ]),
    );
  }
  return value;
}
