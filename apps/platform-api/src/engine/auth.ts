import { Inject, Injectable } from "@nestjs/common";
import { Auth0M2mTokenProvider } from "@alterx/auth";
import { IdentityBrokerService } from "../identity-broker/identity-broker.service";
import { isSystemCallerContext } from "../system-jobs/system-caller";
import type { EngineAuthorization, EngineCallerContext } from "./types";

export const ENGINE_M2M_TOKEN_PROVIDER = Symbol("ENGINE_M2M_TOKEN_PROVIDER");
export const ENGINE_AUTH_PROVIDER = Symbol("ENGINE_AUTH_PROVIDER");

export interface EngineM2mTokenProvider {
  /**
   * Service-level credential proving "this is platform-api", nothing more.
   * Deliberately takes no tenant: per-request tenancy travels in the actor
   * token (X-Alter-Actor-Token), and Auth0's client-credentials grant has no
   * user and no organization. Passing a tenant id here previously reached
   * Auth0 as its `organization` parameter -- an Auth0 Organization id
   * (`org_...`), a different namespace from an Alter tenant UUID -- so every
   * real-Auth0 call failed with "The client is not permitted to use an
   * organization with this audience", and each tenant also cached its own
   * redundant copy of an otherwise identical token.
   */
  getAccessToken(): Promise<string>;
}

export interface EngineAuthProvider {
  authorize(context: EngineCallerContext): Promise<EngineAuthorization>;
}

interface Auth0EngineM2mOptions {
  tokenUrl: string;
  audience: string;
  clientId: string;
  clientSecretRef: string;
  resolveSecret(reference: string): Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

@Injectable()
export class Auth0EngineM2mTokenProvider implements EngineM2mTokenProvider {
  private readonly provider: Auth0M2mTokenProvider;

  constructor(private readonly options: Auth0EngineM2mOptions) {
    this.provider = new Auth0M2mTokenProvider({
      tokenUrl: options.tokenUrl,
      audience: options.audience,
      clientId: options.clientId,
      resolveClientSecret: () => options.resolveSecret(options.clientSecretRef),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async getAccessToken(): Promise<string> {
    return this.provider.getAccessToken();
  }
}

@Injectable()
export class IdentityBrokerEngineAuthProvider implements EngineAuthProvider {
  constructor(
    private readonly identityBroker: IdentityBrokerService,
    @Inject(ENGINE_M2M_TOKEN_PROVIDER)
    private readonly m2mTokenProvider: EngineM2mTokenProvider,
  ) {}

  async authorize(
    context: EngineCallerContext,
  ): Promise<EngineAuthorization> {
    if (isSystemCallerContext(context)) {
      const [m2mAccessToken, system] = await Promise.all([
        this.m2mTokenProvider.getAccessToken(),
        this.identityBroker.mintSystemActorToken({
          tenantId: context.tenantId,
          callingTenantId: context.tenantId,
        }),
      ]);
      return { m2mAccessToken, actorToken: system.token };
    }
    const [m2mAccessToken, actor] = await Promise.all([
      this.m2mTokenProvider.getAccessToken(),
      this.identityBroker.mintActorToken({
        userId: context.userId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        authTime: context.authTime,
        roles: context.roles,
        permissions: context.permissions,
        callingTenantId: context.tenantId,
      }),
    ]);

    return { m2mAccessToken, actorToken: actor.token };
  }
}
