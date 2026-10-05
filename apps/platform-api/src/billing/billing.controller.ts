import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  type RawBodyRequest,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import type {
  Invoice,
  Page,
  PaymentMethodRef,
} from "@alterx/shared-clients";
import type { FastifyRequest } from "fastify";
import { EtagConstrained, EtagResponseInterceptor } from "../concurrency";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  Public,
  RequirePermission,
  RequireTenantRole,
  type ActorContextType,
} from "../rbac";
import { BillingExceptionFilter } from "./billing-exception.filter";
import { BillingHttpError } from "./problem";
import {
  BillingWebhookService,
  type BillingWebhookResult,
} from "./billing-webhook.service";
import { BillingService } from "./billing.service";
import type { BillingSubscriptionView, ConfiguredBillingPlanView } from "./types";
import {
  parseAttachPaymentMethod,
  parseChangeSubscription,
  parseCreateSubscription,
  parseInvoicesQuery,
  parsePaymentMethodRef,
} from "./validation";

@Controller("/api/v1/billing")
@UseFilters(BillingExceptionFilter)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly webhooks: BillingWebhookService,
  ) {}

  @Post("webhooks/:providerId")
  @HttpCode(202)
  @Public()
  webhook(
    @Param("providerId") providerId: string,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Headers("x-razorpay-event-id") providerEventId: string | undefined,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<BillingWebhookResult> {
    if (!request.rawBody) {
      throw new BillingHttpError(
        400,
        "BILLING_WEBHOOK_RAW_BODY_REQUIRED",
        "Webhook raw body is required",
        `/api/v1/billing/webhooks/${encodeURIComponent(providerId)}`,
      );
    }
    return this.webhooks.receive(
      providerId,
      request.rawBody,
      signature ?? "",
      providerEventId ?? "",
    );
  }

  @Get("plans")
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  plans(): Promise<ConfiguredBillingPlanView[]> {
    return this.billing.listPlans();
  }

  @Get("subscription")
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  @UseInterceptors(EtagResponseInterceptor)
  subscription(
    @ActorContext() actor: ActorContextType,
  ): Promise<BillingSubscriptionView | null> {
    return this.billing.getSubscription(actor.tenant_id);
  }

  @Get("credits")
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  credits(@ActorContext() actor:ActorContextType):Promise<{balance:string;reserved:string;available:string}> {
    return this.billing.getCredits(actor.tenant_id);
  }

  @Post("subscription")
  @HttpCode(201)
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  @Idempotent()
  createSubscription(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType,
  ): Promise<BillingSubscriptionView> {
    return this.billing.createSubscription(
      actor.tenant_id,
      parseCreateSubscription(body, "/api/v1/billing/subscription"),
      actor.user_id,
    );
  }

  @Patch("subscription")
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  @EtagConstrained()
  @Idempotent()
  changeSubscription(
    @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
    @ActorContext() actor: ActorContextType,
  ): Promise<BillingSubscriptionView> {
    return this.billing.changeSubscription(
      actor.tenant_id,
      parseChangeSubscription(body, "/api/v1/billing/subscription"),
      actor.user_id,
      ifMatch,
    );
  }

  @Delete("subscription")
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  @EtagConstrained()
  @Idempotent()
  cancelSubscription(
    @Headers("if-match") ifMatch: string | undefined,
    @ActorContext() actor: ActorContextType,
  ): Promise<BillingSubscriptionView> {
    return this.billing.cancelSubscription(actor.tenant_id,actor.user_id,ifMatch);
  }

  @Get("invoices")
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  invoices(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @ActorContext() actor: ActorContextType,
  ): Promise<Page<Invoice>> {
    const query = parseInvoicesQuery(
      cursor,
      limit,
      "/api/v1/billing/invoices",
    );
    return this.billing.listInvoices(
      actor.tenant_id,
      query.cursor,
      query.limit,
    );
  }

  @Get("payment-methods")
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  paymentMethods(
    @ActorContext() actor: ActorContextType,
  ): Promise<PaymentMethodRef[]> {
    return this.billing.listPaymentMethods(actor.tenant_id);
  }

  @Post("payment-methods")
  @HttpCode(201)
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  @Idempotent()
  attachPaymentMethod(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType,
  ): Promise<PaymentMethodRef> {
    return this.billing.attachPaymentMethod(
      actor.tenant_id,
      parseAttachPaymentMethod(body, "/api/v1/billing/payment-methods"),
    );
  }

  @Delete("payment-methods/:ref")
  @HttpCode(204)
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  @Idempotent()
  detachPaymentMethod(
    @Param("ref") ref: string,
    @ActorContext() actor: ActorContextType,
  ): Promise<void> {
    const instance =
      `/api/v1/billing/payment-methods/${encodeURIComponent(ref)}`;
    return this.billing.detachPaymentMethod(
      actor.tenant_id,
      parsePaymentMethodRef(ref, instance),
    );
  }
}
