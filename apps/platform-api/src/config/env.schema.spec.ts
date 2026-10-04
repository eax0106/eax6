import { describe, expect, it } from "vitest";
import { platformApiConfigSource, validatePlatformApiEnv } from "./env.schema";

describe("platformApiEnvSchema", () => {
  const cursorSecret = "test-search-cursor-secret";

  it("requires the registry token reference when the engine URL is configured", () => {
    const base = { DATABASE_URL: "postgres://localhost/platform_db", MARKETPLACE_DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret, SIGNING_KEY_PROVIDER: "mock", ENGINE_BASE_URL: "http://engine.test" };
    expect(() => validatePlatformApiEnv(base)).toThrow(/CONNECTION_REGISTRY_SERVICE_TOKEN_REF/);
    expect(() => validatePlatformApiEnv({ ...base, CONNECTION_REGISTRY_SERVICE_TOKEN_REF: "env:CONNECTION_REGISTRY_SERVICE_TOKEN" })).toThrow(/BILLING_SYNC_SERVICE_TOKEN_REF/);
    expect(validatePlatformApiEnv({ ...base, CONNECTION_REGISTRY_SERVICE_TOKEN_REF: "env:CONNECTION_REGISTRY_SERVICE_TOKEN",
      BILLING_SYNC_SERVICE_TOKEN_REF: "env:BILLING_SYNC_SERVICE_TOKEN" }).ENGINE_BASE_URL).toBe(base.ENGINE_BASE_URL);
  });

  it("requires a dedicated retention URL in real mode", () => {
    const base = { DATABASE_URL: "postgres://localhost/platform_db", MARKETPLACE_DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret, SIGNING_KEY_PROVIDER: "mock", RUNTIME_MODE: "real" };
    expect(() => validatePlatformApiEnv(base)).toThrow(/PLATFORM_RETENTION_DATABASE_URL/);
    expect(() => validatePlatformApiEnv({ ...base, PLATFORM_RETENTION_DATABASE_URL: "postgres://platform_app:fixture@localhost/platform_db" })).toThrow(/platform_retention/);
    expect(validatePlatformApiEnv({ ...base, PLATFORM_RETENTION_DATABASE_URL: "postgres://platform_retention:fixture@localhost/platform_db" }).RUNTIME_MODE).toBe("real");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => validatePlatformApiEnv({})).toThrow(
      "Invalid platform-api environment",
    );
  });

  it("requires the marketplace cursor secret at startup", () => {
    expect(() =>
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://localhost/platform_db",
        MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
        SIGNING_KEY_PROVIDER: "mock",
      }),
    ).toThrow("MARKETPLACE_SEARCH_CURSOR_SECRET");
  });

  it("accepts local database URL and reserved Redis parameter", () => {
    expect(
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
        MARKETPLACE_DATABASE_URL:
          "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        ACTOR_TOKEN_SIGNING_KEY_REF: "env:ACTOR_TOKEN_PRIVATE_KEY",
        REDIS_ENDPOINT_PARAM: "/alter/dev/platform-api/redis-endpoint",
        ALTER_CONFIG_SOURCE: "local-file",
      }),
    ).toEqual({
      DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
      MARKETPLACE_DATABASE_URL:
        "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      ACTOR_TOKEN_SIGNING_KEY_REF: "env:ACTOR_TOKEN_PRIVATE_KEY",
      IDENTITY_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      REDIS_ENDPOINT_PARAM: "/alter/dev/platform-api/redis-endpoint",
      WORKSPACE_DELETION_WINDOW_DAYS: 7,
      SIGNING_KEY_PROVIDER: "secrets",
      ALTER_CONFIG_SOURCE: "local-file",
      MARKETPLACE_OBJECT_STORAGE_PROVIDER: "mock",
      REGISTRY_SCAN_PROVIDER: "osv",
      STATUS_PAGE_PROVIDER: "mock",
      RUNTIME_MODE: "mock",
    });
  });

  it("honours deprecated service-scoped config source", () => {
    expect(
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
        MARKETPLACE_DATABASE_URL:
          "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        ACTOR_TOKEN_SIGNING_KEY_REF: "env:ACTOR_TOKEN_PRIVATE_KEY",
        ALTER_CONFIG_SOURCE: "local-file",
        RUNTIME_MODE: "mock",
        PLATFORM_API_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APP_ID: "app",
        APPCONFIG_ENV_ID: "env",
        APPCONFIG_PROFILE_ID: "profile",
      }).ALTER_CONFIG_SOURCE,
    ).toBe("appconfig");
  });

  it("rejects mock runtime mode in production", () => {
    expect(() =>
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://localhost/platform_db",
        MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        NODE_ENV: "production",
        RUNTIME_MODE: "mock",
      }),
    ).toThrow(/RUNTIME_MODE=mock/);
  });

  it("requires Auth0 refs when Auth0 provider is selected", () => {
    expect(() =>
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
        MARKETPLACE_DATABASE_URL:
          "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        ACTOR_TOKEN_SIGNING_KEY_REF: "env:ACTOR_TOKEN_PRIVATE_KEY",
        IDENTITY_PROVIDER: "auth0",
      }),
    ).toThrow("AUTH0_DOMAIN required when IDENTITY_PROVIDER=auth0");
  });

  it("allows explicit test mock mode without a secret reference", () => {
    expect(
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
        MARKETPLACE_DATABASE_URL:
          "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        SIGNING_KEY_PROVIDER: "mock",
      }),
    ).toMatchObject({ SIGNING_KEY_PROVIDER: "mock" });
  });

  it("requires AppConfig identifiers in appconfig mode", () => {
    expect(() =>
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://localhost/platform_db",
        MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        ALTER_CONFIG_SOURCE: "appconfig",
      }),
    ).toThrow("APPCONFIG_APP_ID required");
  });

  it("accepts the canonical long-form AppConfig identifiers in appconfig mode", () => {
    const env = validatePlatformApiEnv({
      DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      SIGNING_KEY_PROVIDER: "mock",
      ALTER_CONFIG_SOURCE: "appconfig",
      APPCONFIG_APPLICATION_ID: "alterx-engine",
      APPCONFIG_ENVIRONMENT_ID: "local",
      APPCONFIG_CONFIGURATION_PROFILE_ID: "engine-local",
    });
    expect(env.APPCONFIG_APP_ID).toBe("alterx-engine");
    expect(env.APPCONFIG_ENV_ID).toBe("local");
    expect(env.APPCONFIG_PROFILE_ID).toBe("engine-local");
  });

  it("prefers the canonical long-form AppConfig identifiers over the short form", () => {
    const env = validatePlatformApiEnv({
      DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      SIGNING_KEY_PROVIDER: "mock",
      ALTER_CONFIG_SOURCE: "appconfig",
      APPCONFIG_APPLICATION_ID: "alterx-engine-long",
      APPCONFIG_APP_ID: "alterx-engine-short",
      APPCONFIG_ENVIRONMENT_ID: "local",
      APPCONFIG_CONFIGURATION_PROFILE_ID: "engine-local",
    });
    expect(env.APPCONFIG_APP_ID).toBe("alterx-engine-long");
  });

  it("reads the workspace deletion window in whole days, 1 to 30, default 7 (D2)", () => {
    const base = { DATABASE_URL: "postgres://localhost/platform_db", MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db", MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret, SIGNING_KEY_PROVIDER: "mock" };
    expect(validatePlatformApiEnv(base).WORKSPACE_DELETION_WINDOW_DAYS).toBe(7);
    expect(validatePlatformApiEnv({ ...base, WORKSPACE_DELETION_WINDOW_DAYS: "14" }).WORKSPACE_DELETION_WINDOW_DAYS).toBe(14);
    for (const invalid of ["0", "31", "1.5", "seven"]) {
      expect(() => validatePlatformApiEnv({ ...base, WORKSPACE_DELETION_WINDOW_DAYS: invalid })).toThrow("Invalid platform-api environment");
    }
  });

  it("selects marketplace object storage explicitly", () => {
    const base = { DATABASE_URL: "postgres://localhost/platform_db", MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db", MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret, SIGNING_KEY_PROVIDER: "mock" };
    expect(validatePlatformApiEnv(base).MARKETPLACE_OBJECT_STORAGE_PROVIDER).toBe("mock");
    expect(validatePlatformApiEnv({ ...base, MARKETPLACE_OBJECT_STORAGE_PROVIDER: "s3", AWS_REGION: "ap-south-1" }).MARKETPLACE_OBJECT_STORAGE_PROVIDER).toBe("s3");
    expect(() => validatePlatformApiEnv({ ...base, MARKETPLACE_OBJECT_STORAGE_PROVIDER: "gcs" })).toThrow("Invalid platform-api environment");
    expect(() => validatePlatformApiEnv({ ...base, MARKETPLACE_OBJECT_STORAGE_PROVIDER: "s3" })).toThrow("AWS_REGION required when MARKETPLACE_OBJECT_STORAGE_PROVIDER=s3");
  });

  it("fails loudly until SCAN-1 when sandbox scanning is selected", () => {
    const base = { DATABASE_URL: "postgres://localhost/platform_db", MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db", MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret, SIGNING_KEY_PROVIDER: "mock" };
    expect(validatePlatformApiEnv(base).REGISTRY_SCAN_PROVIDER).toBe("osv");
    expect(() => validatePlatformApiEnv({ ...base, REGISTRY_SCAN_PROVIDER: "sandbox" })).toThrow("Invalid platform-api environment");
    expect(() => validatePlatformApiEnv({ ...base, REGISTRY_SCAN_PROVIDER: "mock" })).toThrow("Invalid platform-api environment");
    expect(() => validatePlatformApiEnv({ ...base, REGISTRY_SCAN_PROVIDER: "other" })).toThrow("Invalid platform-api environment");
  });

  it("requires SES refs when the SES email provider is selected", () => {
    expect(() =>
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
        MARKETPLACE_DATABASE_URL:
          "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        SIGNING_KEY_PROVIDER: "mock",
        EMAIL_PROVIDER: "ses",
      }),
    ).toThrow("SES_FROM_ADDRESS required when EMAIL_PROVIDER=ses");
    expect(
      validatePlatformApiEnv({
        DATABASE_URL: "postgres://platform_api:platform_api_local@localhost:5432/platform_db",
        MARKETPLACE_DATABASE_URL:
          "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db",
        MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
        SIGNING_KEY_PROVIDER: "mock",
        EMAIL_PROVIDER: "ses",
        SES_FROM_ADDRESS: "no-reply@alter.test",
        SES_CREDENTIALS_SECRET_REF: "/alter/prod/ses/credentials",
      }).EMAIL_PROVIDER,
    ).toBe("ses");
  });

  it("requires Statuspage identifiers when real publishing is selected", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      SIGNING_KEY_PROVIDER: "mock",
      STATUS_PAGE_PROVIDER: "atlassian",
    } as const;
    expect(() => validatePlatformApiEnv(base)).toThrow("STATUSPAGE_PAGE_ID required");
    expect(validatePlatformApiEnv({
      ...base,
      STATUSPAGE_PAGE_ID: "page_123",
      STATUSPAGE_API_TOKEN_SECRET_REF: "/alter/statuspage/api-token",
    })).toMatchObject({ STATUS_PAGE_PROVIDER: "atlassian" });
  });

  it("requires model gateway admin URL and token reference together", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      SIGNING_KEY_PROVIDER: "mock",
    } as const;
    expect(() => validatePlatformApiEnv({
      ...base,
      MODEL_GATEWAY_ADMIN_BASE_URL: "http://model-gateway.test",
    })).toThrow("configured together");
    expect(validatePlatformApiEnv({
      ...base,
      MODEL_GATEWAY_ADMIN_BASE_URL: "http://model-gateway.test",
      MODEL_GATEWAY_ADMIN_TOKEN_REF: "/alter/model-gateway/admin-token",
    })).toMatchObject({
      MODEL_GATEWAY_ADMIN_BASE_URL: "http://model-gateway.test",
      MODEL_GATEWAY_ADMIN_TOKEN_REF: "/alter/model-gateway/admin-token",
    });
  });

  it("requires both privileged Operations database bindings", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/platform_db",
      MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      SIGNING_KEY_PROVIDER: "mock",
    } as const;
    expect(() => validatePlatformApiEnv({
      ...base,
      OPERATIONS_PLATFORM_DATABASE_URL: "postgres://localhost/platform_admin",
    })).toThrow("configured together");
    expect(validatePlatformApiEnv({
      ...base,
      OPERATIONS_PLATFORM_DATABASE_URL: "postgres://localhost/platform_admin",
      OPERATIONS_MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_admin",
    })).toMatchObject({
      OPERATIONS_PLATFORM_DATABASE_URL: "postgres://localhost/platform_admin",
      OPERATIONS_MARKETPLACE_DATABASE_URL: "postgres://localhost/marketplace_admin",
    });
  });

  // Legacy ALTER_CONFIG_SOURCE=mock maps to platform-api's local-file source.
  describe("config source", () => {
    const base = {
      DATABASE_URL: "postgres://localhost:5432/platform_db",
      MARKETPLACE_DATABASE_URL: "postgres://localhost:5432/marketplace_db",
      MARKETPLACE_SEARCH_CURSOR_SECRET: cursorSecret,
      SIGNING_KEY_PROVIDER: "mock" as const,
    };

    it("does not fail on the shared Engine value", () => {
      expect(
        validatePlatformApiEnv({ ...base, ALTER_CONFIG_SOURCE: "mock" })
          .ALTER_CONFIG_SOURCE,
      ).toBe("local-file");
    });

    it("prefers the scoped variable over the shared one", () => {
      expect(
        validatePlatformApiEnv({
          ...base,
          ALTER_CONFIG_SOURCE: "mock",
          PLATFORM_API_CONFIG_SOURCE: "appconfig",
          APPCONFIG_APP_ID: "app",
          APPCONFIG_ENV_ID: "env",
          APPCONFIG_PROFILE_ID: "profile",
        }).ALTER_CONFIG_SOURCE,
      ).toBe("appconfig");
    });

    it("still honours a shared value platform-api understands", () => {
      expect(
        validatePlatformApiEnv({ ...base, ALTER_CONFIG_SOURCE: "local-file" })
          .ALTER_CONFIG_SOURCE,
      ).toBe("local-file");
    });

    it("resolves the same way for the direct process.env readers", () => {
      expect(
        platformApiConfigSource({ ALTER_CONFIG_SOURCE: "mock" }),
      ).toBe("local-file");
      expect(
        platformApiConfigSource({
          ALTER_CONFIG_SOURCE: "mock",
          PLATFORM_API_CONFIG_SOURCE: "appconfig",
        }),
      ).toBe("appconfig");
    });
  });
});
