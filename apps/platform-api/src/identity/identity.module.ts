import { Module } from "@nestjs/common";
import pg from "pg";
import {
  Auth0IdentityProvider,
  type Auth0IdentityProviderOptions,
} from "./adapters/auth0/auth0-identity-provider";
import {
  GoogleIdentityProvider,
  type GoogleIdentityProviderOptions,
} from "./adapters/google/google-identity-provider";
import { MockIdentityProvider } from "./adapters/mock/mock-identity-provider";
import { IdentityController } from "./identity.controller";
import type { IdentityProvider } from "./identity-provider.interface";
import { IdentityService } from "./identity.service";
import { UserProfileRepository } from "./user-profile.repository";
import { InMemorySessionStore, PgSessionStore, type SessionStore } from "./session-store";
import {
  InMemorySsoConfigStore,
  PgSsoConfigStore,
  type SsoConfigStore,
} from "./sso-config-store";

export const IDENTITY_PROVIDER = Symbol("IdentityProvider");
const sessionStoreToken = Symbol("SessionStore");
const ssoConfigStoreToken = Symbol("SsoConfigStore");
const databasePoolToken = Symbol("DatabasePool");

@Module({
  controllers: [IdentityController],
  providers: [
    {
      provide: databasePoolToken,
      useFactory: (): pg.Pool | undefined =>
        process.env.DATABASE_URL
          ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
          : undefined,
    },
    {
      provide: sessionStoreToken,
      useFactory: (pool: pg.Pool | undefined): SessionStore =>
        pool ? new PgSessionStore(pool) : new InMemorySessionStore(),
      inject: [databasePoolToken],
    },
    {
      provide: ssoConfigStoreToken,
      useFactory: (pool: pg.Pool | undefined): SsoConfigStore =>
        pool ? new PgSsoConfigStore(pool) : new InMemorySsoConfigStore(),
      inject: [databasePoolToken],
    },
    {
      provide: UserProfileRepository,
      useFactory: (pool: pg.Pool | undefined): UserProfileRepository =>
        new UserProfileRepository(pool),
      inject: [databasePoolToken],
    },
    {
      provide: IDENTITY_PROVIDER,
      // ENGINE-FIX-P3-17: was three independent ad-hoc `process.env.X &&`
      // chains -- an explicitly selected real provider missing its config
      // silently fell through to MockIdentityProvider instead of failing
      // loud, and mock (the default) had no check at all against running
      // in production. Now IDENTITY_PROVIDER drives an explicit switch:
      // a selected real provider missing config throws (was silent
      // downgrade); mock is fatal when NODE_ENV=production (mirrors
      // identity-broker.module.ts's SIGNING_KEY_PROVIDER=mock gate, and
      // sandbox-service's localMock boot check).
      useFactory: (sessionStore: SessionStore, ssoConfigStore: SsoConfigStore): IdentityProvider =>
        createIdentityProvider(sessionStore, ssoConfigStore),
      inject: [sessionStoreToken, ssoConfigStoreToken],
    },
    {
      provide: IdentityService,
      useFactory: (identityProvider: IdentityProvider, sessionStore: SessionStore) =>
        new IdentityService(identityProvider, sessionStore),
      inject: [IDENTITY_PROVIDER, sessionStoreToken],
    },
  ],
  exports: [IDENTITY_PROVIDER, IdentityService, UserProfileRepository],
})
export class IdentityModule {}

export async function resolveRuntimeSecret(reference: string): Promise<string> {
  const environmentKey = reference.startsWith("env:")
    ? reference.slice("env:".length)
    : reference;
  const value = process.env[environmentKey];
  if (!value) {
    throw new Error(`Secret reference unavailable: ${reference}`);
  }
  return value;
}

/**
 * The identity provider IDENTITY_PROVIDER selects. Exported so the EC2
 * production-config check (deploy/ec2/check-production-config.ts) runs this
 * exact selection, not a copy of it.
 */
export function createIdentityProvider(
  sessionStore: SessionStore,
  ssoConfigStore: SsoConfigStore,
): IdentityProvider {
  const provider = process.env.IDENTITY_PROVIDER ?? "mock";

  if (provider === "auth0") {
    if (!process.env.AUTH0_DOMAIN || !process.env.AUTH0_CLIENT_ID) {
      throw new Error(
        "AUTH0_DOMAIN and AUTH0_CLIENT_ID are required when IDENTITY_PROVIDER=auth0",
      );
    }
    const options: Auth0IdentityProviderOptions = {
      domain: process.env.AUTH0_DOMAIN,
      clientId: process.env.AUTH0_CLIENT_ID,
      resolveSecret: resolveRuntimeSecret,
    };
    if (process.env.AUTH0_CLIENT_SECRET_REF) {
      options.clientSecretRef = process.env.AUTH0_CLIENT_SECRET_REF;
    }
    if (process.env.AUTH0_M2M_CLIENT_ID) {
      options.m2mClientId = process.env.AUTH0_M2M_CLIENT_ID;
    }
    if (process.env.AUTH0_M2M_CLIENT_SECRET_REF) {
      options.m2mClientSecretRef = process.env.AUTH0_M2M_CLIENT_SECRET_REF;
    }
    return new Auth0IdentityProvider(options, sessionStore, ssoConfigStore);
  }

  if (provider === "google") {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET_REF) {
      throw new Error(
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET_REF are required when IDENTITY_PROVIDER=google",
      );
    }
    const options: GoogleIdentityProviderOptions = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecretRef: process.env.GOOGLE_CLIENT_SECRET_REF,
      resolveSecret: resolveRuntimeSecret,
    };
    return new GoogleIdentityProvider(options, sessionStore);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("IDENTITY_PROVIDER=mock is not allowed when NODE_ENV=production");
  }
  return new MockIdentityProvider(sessionStore, ssoConfigStore);
}
