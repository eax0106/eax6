import { APP_GUARD } from "@nestjs/core";
import {
  SessionGatewayGuard,
  SessionGatewayRateLimitGuard,
  SessionGatewayUploadAllowlistGuard,
} from "@alterx/auth";
import { describe, expect, it, vi } from "vitest";
import { SecurityModule } from "./security.module";

interface GlobalGuardProvider {
  readonly provide: symbol;
  readonly useFactory: () => unknown;
}

/**
 * The three Session Gateway APP_GUARD registrations moved into
 * SecurityModule as part of the app.module.ts split
 * (docs/design/app-module-split.md) -- APP_GUARD applies globally
 * regardless of which module in the import graph registers it (this is
 * documented Nest behavior, not something specific to the root module), so
 * this is a structural update to match the new, correct location, not a
 * change to what's actually being verified: the guard chain still exists,
 * still authenticates before rate-limiting/upload-allowlisting, and still
 * fails closed on bad config -- same assertions below, unchanged.
 */
function globalGuardProviders(): readonly GlobalGuardProvider[] {
  const providers = Reflect.getMetadata("providers", SecurityModule) as unknown[];
  const guards = providers.filter(
    (candidate): candidate is GlobalGuardProvider =>
      typeof candidate === "object" &&
      candidate !== null &&
      "provide" in candidate &&
      candidate.provide === APP_GUARD,
  );
  if (guards.length === 0) {
    throw new Error("Session Gateway APP_GUARD is not registered");
  }
  return guards;
}

const VALID_CONFIG = {
  // Pinned so this test exercises the iam-auth branch regardless of a
  // repo-root .env.local (Vite auto-loads it into every vitest run) --
  // without this, an ambient ALTER_ENV=local would route identityTenantGatewayEnvironment()
  // into the static-auth branch instead, which needs ORCHESTRATION_DATABASE_URL
  // rather than the HOST/PORT/NAME/USER fields this test actually stubs.
  ALTER_ENV: "dev",
  AUTH0_DOMAIN: "tenant.auth0.com",
  AUTH0_API_AUDIENCE: "alter-engine",
  ACTOR_TOKEN_ISSUER: "alter-platform-api.identity-broker",
  ACTOR_TOKEN_AUDIENCE: "alter-engine",
  ACTOR_TOKEN_JWKS_URL: "https://identity.example.test/actor-jwks",
  REDIS_ENDPOINT: "redis://localhost:6379",
  ORCHESTRATION_DATABASE_HOST: "localhost",
  ORCHESTRATION_DATABASE_PORT: "5432",
  ORCHESTRATION_DATABASE_NAME: "orchestration_db",
  ORCHESTRATION_DATABASE_USER: "orchestration_service",
  AWS_REGION: "ap-south-1",
  ALTER_ARTIFACTS_BUCKET_PARAM: "/alter/local/orchestration/artifacts-bucket",
} as const;

function stubConfig(overrides: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({
    ...VALID_CONFIG,
    ...overrides,
  })) {
    vi.stubEnv(name, value);
  }
}

describe("AppModule Session Gateway registration", () => {
  it("registers the Session Gateway globally and fails on missing config", () => {
    const provider = globalGuardProviders()[0]!;
    expect(provider.provide).toBe(APP_GUARD);
    vi.stubEnv("AUTH0_DOMAIN", "");
    try {
      expect(provider.useFactory).toThrow(
        "Missing required Identity & Tenant Gateway configuration",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds the guard when all required references are present", () => {
    stubConfig();
    try {
      expect(globalGuardProviders()[0]!.useFactory()).toBeInstanceOf(
        SessionGatewayGuard,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("registers rate limiting and upload validation after authentication", () => {
    stubConfig();
    try {
      const guards = globalGuardProviders();
      expect(guards).toHaveLength(3);
      expect(guards[0]!.useFactory()).toBeInstanceOf(SessionGatewayGuard);
      expect(guards[1]!.useFactory()).toBeInstanceOf(
        SessionGatewayRateLimitGuard,
      );
      expect(guards[2]!.useFactory()).toBeInstanceOf(
        SessionGatewayUploadAllowlistGuard,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when production feature flag is not enabled", () => {
    // Explicitly cleared: a repo-root .env.local (Vite auto-loads it into
    // every vitest run) may set this to "true" for local service boots,
    // which would otherwise mask the "flag not enabled" case this test
    // exists to cover.
    stubConfig({ NODE_ENV: "production", INGRESS_SESSION_GATEWAY_CORE_ENABLED: "" });
    try {
      expect(globalGuardProviders()[0]!.useFactory).toThrow(
        "Production Identity & Tenant Gateway requires the core ingress feature flag",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when production actor-token JWKS configuration is missing", () => {
    stubConfig({
      NODE_ENV: "production",
      INGRESS_SESSION_GATEWAY_CORE_ENABLED: "true",
      ACTOR_TOKEN_JWKS_URL: "",
    });
    try {
      expect(globalGuardProviders()[0]!.useFactory).toThrow(
        "Missing required Identity & Tenant Gateway configuration: ACTOR_TOKEN_JWKS_URL",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects test signer activation in production", () => {
    stubConfig({
      NODE_ENV: "production",
      INGRESS_SESSION_GATEWAY_CORE_ENABLED: "true",
      ACTOR_TOKEN_TEST_SIGNER_ENABLED: "true",
    });
    try {
      expect(globalGuardProviders()[0]!.useFactory).toThrow(
        "Actor-token test signer cannot be enabled in production",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds the guard in production when rollout gates are configured", () => {
    stubConfig({
      NODE_ENV: "production",
      INGRESS_SESSION_GATEWAY_CORE_ENABLED: "true",
    });
    try {
      expect(globalGuardProviders()[0]!.useFactory()).toBeInstanceOf(
        SessionGatewayGuard,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
