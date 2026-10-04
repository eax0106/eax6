import { Module } from "@nestjs/common";
import { sharedPool } from "../db/shared-pool";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { CONFIG_PROVIDER, type ConfigProvider } from "../entitlements/config-provider.interface";
import { PLAN_DEFINITION_STORE, type PlanDefinitionStore } from "../entitlements/plan-definition-store";
import { BillingPolicyService } from "./billing-policy.service";
import { billingPolicyDependenciesFromEnvironment } from "../engine/billing-policy-client";
import { ENTITLEMENT_PROVIDER,type EntitlementProvider } from "../entitlements/entitlement-provider.interface";
@Module({imports:[EntitlementsModule],providers:[{
  provide:BillingPolicyService,inject:[CONFIG_PROVIDER,PLAN_DEFINITION_STORE,ENTITLEMENT_PROVIDER],
  useFactory:(config:ConfigProvider,definitions:PlanDefinitionStore,entitlements:EntitlementProvider)=>{
    const {databaseUrl,client}=billingPolicyDependenciesFromEnvironment();
    return new BillingPolicyService(sharedPool(databaseUrl),config,definitions,client,entitlements);
  },
}],exports:[BillingPolicyService]})
export class BillingPolicyModule {}
