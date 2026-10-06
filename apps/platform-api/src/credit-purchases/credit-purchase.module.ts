import { Module } from "@nestjs/common";
import { AwsSecretsManagerProvider, RazorpayCreditPurchaseProvider } from "@alterx/adapters";
import type { CreditPurchaseProvider } from "@alterx/shared-clients";
import { sharedPool } from "../db/shared-pool";
import { EngineModule } from "../engine/engine.module";
import { AuditEventsClient } from "../engine/audit-events-client";
import { BillingPolicyModule } from "../billing/billing-policy.module";
import { BillingPolicyService } from "../billing/billing-policy.service";
import { BillingWebhookRepository } from "../billing/billing-webhook.repository";
import { creditPurchaseConfigFromEnvironment } from "./config";
import { CreditPurchaseController } from "./credit-purchase.controller";
import { CreditPurchaseRepository } from "./credit-purchase.repository";
import { CreditPurchaseService } from "./credit-purchase.service";

export const CREDIT_PURCHASE_PROVIDER = Symbol("CREDIT_PURCHASE_PROVIDER");

@Module({
  imports: [EngineModule, BillingPolicyModule],
  controllers: [CreditPurchaseController],
  providers: [
    { provide: CreditPurchaseRepository, useFactory: () => {
      const config = creditPurchaseConfigFromEnvironment(process.env);
      return new CreditPurchaseRepository(sharedPool(config.databaseUrl), sharedPool(config.operationsDatabaseUrl));
    } },
    { provide: CREDIT_PURCHASE_PROVIDER, useFactory: () => {
      const config = creditPurchaseConfigFromEnvironment(process.env);
      return new RazorpayCreditPurchaseProvider(config, new AwsSecretsManagerProvider({ region: config.region }));
    } },
    { provide: CreditPurchaseService, inject: [CreditPurchaseRepository, CREDIT_PURCHASE_PROVIDER, AuditEventsClient, BillingPolicyService],
      useFactory: (repository: CreditPurchaseRepository, provider: CreditPurchaseProvider, audit: AuditEventsClient, delivery: BillingPolicyService) =>
        new CreditPurchaseService(repository, provider, audit, delivery, new BillingWebhookRepository(sharedPool(creditPurchaseConfigFromEnvironment(process.env).databaseUrl))) },
  ],
  exports: [CreditPurchaseService],
})
export class CreditPurchaseModule {}
