import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  SYSTEM_PLATFORM_JOBS_PERMISSIONS,
  SYSTEM_PLATFORM_JOBS_PRINCIPAL,
  type SystemActorTokenClaims,
} from "@alterx/contracts";
import type {
  ActorTokenClaims,
  MintActorTokenInput,
  MintedActorToken,
  MintedSystemActorToken,
  MintServiceActorTokenInput,
  MintSystemActorTokenInput,
} from "./actor-token.types";
import { IdentityBrokerError } from "./identity-broker.error";
import { toPrefixedUuidV7 } from "./id-compat";
import { actorTokenJwk, signActorToken } from "./jwt";
import type { SigningKeyResolver } from "./signing-key-resolver";

const actorTokenLifetimeSeconds = 300;
const issuer = "alter-platform-api.identity-broker";
const audience = "alter-engine";
const serviceWorkspaceId = "workspace_system";

@Injectable()
export class IdentityBrokerService {
  constructor(
    private readonly signingKeyRef: string,
    private readonly signingKeyResolver: SigningKeyResolver,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async mintActorToken(input: MintActorTokenInput): Promise<MintedActorToken> {
    this.assertTenantScope(input.tenantId, input.callingTenantId);

    return this.signClaims({
      user_id: prefixedId("usr", input.userId),
      tenant_id: prefixedId("ten", input.tenantId),
      workspace_id: prefixedId("ws", input.workspaceId),
      roles: [...input.roles],
      permissions: [...input.permissions],
      session_id: input.sessionId,
      auth_time: input.authTime,
      ...this.freshRegisteredClaims(),
    });
  }

  async mintServiceActorToken(
    input: MintServiceActorTokenInput,
  ): Promise<MintedActorToken> {
    this.assertTenantScope(input.tenantId, input.callingTenantId);

    return this.signClaims({
      user_id: serviceUserId(input.serviceName),
      tenant_id: prefixedId("ten", input.tenantId),
      workspace_id: prefixedId("ws", input.workspaceId ?? serviceWorkspaceId),
      roles: ["service"],
      permissions: [...(input.permissions ?? [])],
      session_id: `svc_session_${input.serviceName}`,
      auth_time: this.nowSeconds(),
      ...this.freshRegisteredClaims(),
    });
  }

  /**
   * The system caller (D1): a single-use token for `system:platform-jobs`,
   * bound to one tenant, no user, no workspace, the fixed read-only permission
   * set. Not reachable from a request: the only caller is the engine auth
   * provider, and only for a context made by `createSystemCallerContext`,
   * which no controller may import (see system-caller.spec.ts).
   */
  async mintSystemActorToken(
    input: MintSystemActorTokenInput,
  ): Promise<MintedSystemActorToken> {
    this.assertTenantScope(input.tenantId, input.callingTenantId);

    const claims: SystemActorTokenClaims = {
      principal_type: "system",
      principal: SYSTEM_PLATFORM_JOBS_PRINCIPAL,
      tenant_id: prefixedId("ten", input.tenantId),
      permissions: [...SYSTEM_PLATFORM_JOBS_PERMISSIONS],
      auth_time: this.nowSeconds(),
      ...this.freshRegisteredClaims(),
    };
    const privateKey = await this.signingKeyResolver.resolvePrivateKey(this.signingKeyRef);
    return { token: signActorToken(claims, privateKey), claims };
  }

  async publicJwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const publicKey = await this.signingKeyResolver.resolvePublicKey(this.signingKeyRef);
    return { keys: [actorTokenJwk(publicKey)] };
  }

  private async signClaims(claims: ActorTokenClaims): Promise<MintedActorToken> {
    const privateKey = await this.signingKeyResolver.resolvePrivateKey(this.signingKeyRef);
    return {
      token: signActorToken(claims, privateKey),
      claims,
    };
  }

  private freshRegisteredClaims(): Pick<ActorTokenClaims, "jti" | "iss" | "aud" | "iat" | "exp"> {
    const iat = this.nowSeconds();
    return {
      jti: randomUUID(),
      iss: issuer,
      aud: audience,
      iat,
      exp: iat + actorTokenLifetimeSeconds,
    };
  }

  private assertTenantScope(tenantId: string, callingTenantId: string): void {
    if (tenantId !== callingTenantId) {
      throw new IdentityBrokerError(
        "ACTOR_TOKEN_TENANT_MISMATCH",
        "Actor tenant does not match calling context",
      );
    }
  }
}

export function serviceUserId(serviceName: string): string {
  const normalized = serviceName.toLowerCase().replaceAll(/[^a-z0-9]/g, "_");
  return `svc_${normalized}`;
}

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `workspace_system` (the fallback for service tokens with no real
 * workspace) is not a UUID and was never going to satisfy
 * WorkspaceIdSchema either way -- pass it through unwrapped rather than
 * throwing, so an already-non-compliant sentinel doesn't turn into a hard
 * crash.
 */
function prefixedId(prefix: string, id: string): string {
  return uuidShape.test(id) ? toPrefixedUuidV7(prefix, id) : id;
}
