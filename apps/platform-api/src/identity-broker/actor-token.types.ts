import type { SystemActorTokenClaims } from "@alterx/contracts";

export interface ActorTokenClaims {
  user_id: string;
  tenant_id: string;
  workspace_id: string;
  roles: string[];
  permissions: string[];
  session_id: string;
  auth_time: number;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface MintActorTokenInput {
  userId: string;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  authTime: number;
  roles: string[];
  permissions: string[];
  callingTenantId: string;
}

export interface MintServiceActorTokenInput {
  serviceName: string;
  tenantId: string;
  workspaceId?: string;
  permissions?: string[];
  callingTenantId: string;
}

export interface MintSystemActorTokenInput {
  tenantId: string;
  callingTenantId: string;
}

export interface MintedActorToken {
  token: string;
  claims: ActorTokenClaims;
}

export interface MintedSystemActorToken {
  token: string;
  claims: SystemActorTokenClaims;
}
