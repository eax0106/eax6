import type { PoolClient } from "pg";
import type { EffectiveEntitlement } from "../entitlements/types";
import type { IssuedSession } from "../identity/identity.service";
import type { MintedActorToken } from "../identity-broker/actor-token.types";

export interface SignupRequest {
  invitation?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  idempotencyKey: string;
  deviceInfo?: Record<string, unknown>;
  ip?: string;
}

export interface SignupLanding {
  returning: boolean;
  userId: string;
  tenantId: string;
  workspaceId: string;
  tenantRole: string;
  workspaceRole: string;
  onboardingStatus: "not_started";
  entitlement: EffectiveEntitlement;
  actorToken: MintedActorToken;
  session: IssuedSession;
}

export interface ExistingSignup {
  userId: string;
  tenantId: string;
  workspaceId: string;
  tenantRole: string;
  workspaceRole: string;
}

export interface CreateSignupInput {
  userId: string;
  tenantId: string;
  workspaceId: string;
  identityRef: string;
  email: string;
  displayName?: string;
  tenantName: string;
  identityOrgRef: string;
}

export interface SignupPersistence {
  findExisting(identityRef: string, tenantHint: string): Promise<ExistingSignup | null>;
  createSignup<T>(
    input: CreateSignupInput,
    beforeCommit: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
}
