import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import {
  AwsSecretsManagerProvider,
  RazorpayBillingProvider,
} from "@alterx/adapters";
import type { SecretsProvider } from "@alterx/shared-clients";
import { CreditPurchaseModule } from "../credit-purchases/credit-purchase.module";
import { sharedPool } from "../db/shared-pool";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
} from "../concurrency";
import { IdempotencyModule } from "../idempotency";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AdminAuditModule } from "../admin-audit/admin-audit.module";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { AdminBillingController } from "./admin-billing.controller";
import { AdminBillingRepository } from "./admin-billing.repository";
import { AdminBillingService } from "./admin-billing.service";
import { BillingEtagResolver } from "./billing-etag.resolver";
import { BillingExceptionFilter } from "./billing-exception.filter";
import { BillingWebhookRepository } from "./billing-webhook.repository";
import { BillingWebhookService } from "./billing-webhook.service";
import { BillingController } from "./billing.controller";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";
import { BillingPolicyModule } from "./billing-policy.module";
import {
  BILLING_PROVIDER,
  BILLING_SECRETS_PROVIDER,
  BILLING_WEBHOOK_SECRET_REF,
} from "./tokens";

@Module({
  imports: [IdempotencyModule, EntitlementsModule, AdminAuditModule, StaffModule, BillingPolicyModule, CreditPurchaseModule],
  controllers: [BillingController, AdminBillingController],
  providers: [
    {
      provide: BillingRepository,
      useFactory: () => new BillingRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    {
      provide: AdminBillingRepository,
      useFactory: () => new AdminBillingRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    {
      provide: BILLING_SECRETS_PROVIDER,
      useFactory: () =>
        new AwsSecretsManagerProvider({
          region: process.env.AWS_REGION ?? "ap-south-1",
        }),
    },
    {
      provide: BILLING_WEBHOOK_SECRET_REF,
      useFactory: () =>
        process.env.RAZORPAY_WEBHOOK_SECRET_REF ??
        "/alter/billing/razorpay/webhook-secret",
    },
    {
      provide: BillingWebhookRepository,
      useFactory: () => new BillingWebhookRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    {
      provide: BILLING_PROVIDER,
      inject: [BILLING_SECRETS_PROVIDER, BillingRepository],
      useFactory: (
        secrets: SecretsProvider,
        repository: BillingRepository,
      ) =>
        new RazorpayBillingProvider(
          {
            keyIdSecretRef:
              process.env.RAZORPAY_KEY_ID_SECRET_REF ??
              "/alter/billing/razorpay/key-id",
            keySecretSecretRef:
              process.env.RAZORPAY_KEY_SECRET_SECRET_REF ??
              "/alter/billing/razorpay/key-secret",
          },
          secrets,
          repository,
        ),
    },
    BillingService,
    AdminBillingService,
    BillingWebhookService,
    BillingEtagResolver,
    {
      provide: ETAG_RESOURCE_RESOLVER,
      useExisting: BillingEtagResolver,
    },
    IfMatchGuard,
    EtagResponseInterceptor,
    ConcurrencyExceptionFilter,
    BillingExceptionFilter,
  ],
})
export class BillingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(AdminBillingController);
  }
}
