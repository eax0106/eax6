import { MembershipIdentityResolver } from "../identity/membership-identity-resolver";
import { Module } from "@nestjs/common";
import { sharedPool } from "../db/shared-pool";
import {
  ENTITLEMENT_PROVIDER,
  type EntitlementProvider,
} from "../entitlements/entitlement-provider.interface";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { IDENTITY_PROVIDER, IdentityModule } from "../identity/identity.module";
import type { IdentityProvider } from "../identity/identity-provider.interface";
import { IdentityService } from "../identity/identity.service";
import { IdentityBrokerModule } from "../identity-broker/identity-broker.module";
import { IdentityBrokerService } from "../identity-broker/identity-broker.service";
import { OnboardingModule } from "../onboarding/onboarding.module";
import {
  ONBOARDING_INITIALIZER,
  type OnboardingInitializer,
} from "../onboarding/onboarding.repository";
import {
  ProcessLocalSignupIdempotencyStore,
  type IdempotencyStore,
} from "./idempotency-store";
import { PlatformDb } from "./platform-db";
import { SignupController } from "./signup.controller";
import { SignupService } from "./signup.service";

@Module({
  imports: [
    IdentityModule,
    IdentityBrokerModule,
    EntitlementsModule,
    OnboardingModule,
  ],
  controllers: [SignupController],
  providers: [
    {
      provide: PlatformDb,
      useFactory: () => new PlatformDb(sharedPool(process.env.DATABASE_URL)),
    },
    {
      provide: ProcessLocalSignupIdempotencyStore,
      useFactory: () => new ProcessLocalSignupIdempotencyStore(),
    },
    {
      provide: SignupService,
      inject: [
        IDENTITY_PROVIDER,
        IdentityService,
        IdentityBrokerService,
        ENTITLEMENT_PROVIDER,
        PlatformDb,
        ProcessLocalSignupIdempotencyStore,
        ONBOARDING_INITIALIZER,
        MembershipIdentityResolver,
      ],
      useFactory: (
        identityProvider: IdentityProvider,
        identityService: IdentityService,
        identityBroker: IdentityBrokerService,
        entitlementProvider: EntitlementProvider,
        persistence: PlatformDb,
        idempotency: IdempotencyStore,
        onboardingInitializer: OnboardingInitializer,
        resolver: MembershipIdentityResolver,
      ) =>
        new SignupService(
          identityProvider,
          identityService,
          identityBroker,
          entitlementProvider,
          persistence,
          idempotency,
          onboardingInitializer,
          resolver,
        ),
    },
  ],
  exports: [PlatformDb],
})
export class SignupModule {}
