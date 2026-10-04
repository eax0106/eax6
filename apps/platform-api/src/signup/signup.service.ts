import type { MembershipIdentityResolver } from "../identity/membership-identity-resolver";
import { v7 as uuidv7 } from "uuid";
import type { EntitlementProvider } from "../entitlements/entitlement-provider.interface";
import type { IdentityProvider } from "../identity/identity-provider.interface";
import type { IdentityService } from "../identity/identity.service";
import type { IdentityBrokerService } from "../identity-broker/identity-broker.service";
import type { OnboardingInitializer } from "../onboarding/onboarding.repository";
import type { IdempotencyStore } from "./idempotency-store";
import { PlatformHttpError } from "./problem";
import type { SignupLanding, SignupPersistence, SignupRequest } from "./types";

export class SignupService {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly identityService: IdentityService,
    private readonly identityBroker: IdentityBrokerService,
    private readonly entitlementProvider: EntitlementProvider,
    private readonly persistence: SignupPersistence,
    private readonly idempotency: IdempotencyStore,
    private readonly onboardingInitializer: OnboardingInitializer,
    private readonly membershipResolver?: MembershipIdentityResolver,
  ) {}

  signup(request: SignupRequest): Promise<SignupLanding> {
    const payload = {
      code: request.code,
      redirectUri: request.redirectUri,
      codeVerifier: request.codeVerifier,
      invitation: request.invitation,
    };
    return this.idempotency.execute(request.idempotencyKey, payload, async () => {
      const identity = await this.identityProvider.handleCallback({
        code: request.code,
        redirectUri: request.redirectUri,
        codeVerifier: request.codeVerifier,
      });
      if (!identity.emailVerified) {
        throw new PlatformHttpError(
          403,
          "EMAIL_VERIFICATION_REQUIRED",
          "Email must be verified before signup can complete",
          "/api/v1/signup",
        );
      }

      const existing = this.membershipResolver
        ? await this.membershipResolver.resolve(identity, request.invitation)
        : await this.persistence.findExisting(identity.identityRef, identity.tenantId);
      if (existing) {
        return this.landing(
          existing,
          true,
          request.deviceInfo,
          request.ip,
          undefined,
          existing.tenantRole,
          existing.workspaceRole,
        );
      }

      // These IDs get "usr_"/"ten_"/"ws_" prefixed and cross into the
      // workflow/orchestration engine domain, which enforces UUIDv7 bodies
      // (packages/contracts/src/ids.ts) -- crypto.randomUUID() is v4 and
      // fails that check on every real workflow/run call downstream.
      const userId = uuidv7();
      const tenantId = uuidv7();
      const workspaceId = uuidv7();
      const tenantName = `${identity.displayName ?? identity.email.split("@")[0] ?? "Personal"}'s Workspace`;
      const identityOrgRef = await this.identityProvider.getOrCreateOrgForTenant(
        tenantId,
        tenantName,
      );

      const entitlement = await this.persistence.createSignup(
        {
          userId,
          tenantId,
          workspaceId,
          identityRef: identity.identityRef,
          email: identity.email,
          ...(identity.displayName ? { displayName: identity.displayName } : {}),
          tenantName,
          identityOrgRef,
        },
        async (client) => {
          const entitlement = await this.entitlementProvider.createEntitlement(
            tenantId,
            "free",
            client,
          );
          await this.onboardingInitializer.initialize(tenantId, workspaceId, client);
          return entitlement;
        },
      );

      return this.landing(
        { userId, tenantId, workspaceId },
        false,
        request.deviceInfo,
        request.ip,
        entitlement,
      );
    });
  }

  private async landing(
    ids: { userId: string; tenantId: string; workspaceId: string },
    returning: boolean,
    deviceInfo?: Record<string, unknown>,
    ip?: string,
    createdEntitlement?: Awaited<ReturnType<EntitlementProvider["createEntitlement"]>>,
    tenantRole = "owner",
    workspaceRole = "admin",
  ): Promise<SignupLanding> {
    const entitlement =
      createdEntitlement ??
      (await this.entitlementProvider.getEffectiveEntitlement(ids.tenantId));
    const session = await this.identityService.issueSignupSession(
      ids.userId,
      ids.tenantId,
      deviceInfo,
      ip,
    );
    const actorToken = await this.identityBroker.mintActorToken({
      userId: ids.userId,
      tenantId: ids.tenantId,
      workspaceId: ids.workspaceId,
      roles: [tenantRole, workspaceRole],
      permissions: [],
      sessionId: session.sessionId,
      authTime: Math.floor(Date.now() / 1000),
      callingTenantId: ids.tenantId,
    });

    return {
      returning,
      ...ids,
      tenantRole,
      workspaceRole,
      onboardingStatus: "not_started",
      entitlement,
      actorToken,
      session,
    };
  }
}
