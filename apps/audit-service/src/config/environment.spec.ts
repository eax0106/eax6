import { describe, expect, it } from "vitest";

import { AuditConfigurationError, loadAuditEnvironment } from "./environment";

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ALTER_ENV: "local",
    ALTER_SERVICE_NAME: "audit-service",
    ALTER_REGION: "ap-south-1",
    ALTER_CONFIG_SOURCE: "local-file",
    DATABASE_SECRET_REF: "/alter/local/audit-service/system/database_credentials",
    AUDIT_ARCHIVE_BUCKET_PARAM: "/alter/local/audit/archive-bucket",
    ADS_DELETION_BASE_URL: "http://ads-core.internal:8000",
    ORCHESTRATION_DELETION_BASE_URL: "http://orchestration-service.internal:3000",
    PLATFORM_API_DELETION_BASE_URL: "http://platform-api.internal:3020",
    COST_DELETION_BASE_URL: "http://cost-ledger.internal:3000",
    INTELLIGENCE_DELETION_BASE_URL: "http://intelligence.internal:8000",
    EVAL_DELETION_BASE_URL: "http://eval.internal:8003",
    MEMORY_DELETION_BASE_URL: "http://memory.internal:8002",
    DELETION_PSEUDONYM_KEY_REF: "/alter/local/audit-service/system/deletion-pseudonym-key",
    DELETION_SERVICE_TOKEN_REF: "/alter/local/audit-service/system/deletion-service-token",
    AUDIT_CHAIN_SIGNING_KEY_REF: "/alter/local/audit-service/system/chain-signing-key",
    AUDIT_RETENTION_DATABASE_SECRET_REF: "/alter/local/audit-service/retention-database",
    ...overrides,
  };
  if (overrides.ALTER_CONFIG_SOURCE === "appconfig" && overrides.RUNTIME_MODE === undefined) {
    merged.RUNTIME_MODE = "real";
  }
  return merged;
}

describe("loadAuditEnvironment", () => {
  it("validates and returns the documented audit-service environment", () => {
    expect(loadAuditEnvironment(environment())).toEqual({
      alterEnvironment: "local",
      serviceName: "audit-service",
      region: "ap-south-1",
      runtimeMode: "mock",
      configSource: "local-file",
      databaseAuthentication: "static",
      databaseSecretReference:
        "/alter/local/audit-service/system/database_credentials",
      auditArchiveBucketParameter: "/alter/local/audit/archive-bucket",
      httpPort: 3021,
      grpcBindAddress: "0.0.0.0:50068",
      adsDeletionBaseUrl: "http://ads-core.internal:8000",
      orchestrationDeletionBaseUrl: "http://orchestration-service.internal:3000",
      platformApiDeletionBaseUrl: "http://platform-api.internal:3020",
      costDeletionBaseUrl: "http://cost-ledger.internal:3000",
      intelligenceDeletionBaseUrl: "http://intelligence.internal:8000",
      evalDeletionBaseUrl: "http://eval.internal:8003",
      memoryDeletionBaseUrl: "http://memory.internal:8002",
      deletionPseudonymKeyReference: "/alter/local/audit-service/system/deletion-pseudonym-key",
      deletionServiceTokenReference: "/alter/local/audit-service/system/deletion-service-token",
      chainSigningKeyReference: "/alter/local/audit-service/system/chain-signing-key",
      retentionDatabaseSecretReference: "/alter/local/audit-service/retention-database",
    });
  });

  it.each([undefined, "test", "development"])(
    "allows local static authentication when NODE_ENV is %s",
    (nodeEnvironment) => {
      expect(
        loadAuditEnvironment(environment({ NODE_ENV: nodeEnvironment })),
      ).toMatchObject({ databaseAuthentication: "static" });
    },
  );

  it("rejects mock runtime mode when NODE_ENV is production", () => {
    expect(() =>
      loadAuditEnvironment(environment({ NODE_ENV: "production" })),
    ).toThrow(AuditConfigurationError);
    expect(() =>
      loadAuditEnvironment(environment({ NODE_ENV: "production" })),
    ).toThrow(/RUNTIME_MODE/);
  });

  it("accepts validated custom bind ports", () => {
    expect(
      loadAuditEnvironment(
        environment({ PORT: "3100", GRPC_BIND_ADDRESS: "127.0.0.1:51051" }),
      ),
    ).toMatchObject({ httpPort: 3100, grpcBindAddress: "127.0.0.1:51051" });
  });

  // One env file is shared by every service, so a variable named for a role
  // rather than a service can only hold one service's value. The scoped name
  // wins; the shared one stays as the fallback so existing deployments that
  // set only it are unaffected.
  it("prefers the service-scoped bind variables over the shared ones", () => {
    expect(
      loadAuditEnvironment(
        environment({
          PORT: "3100",
          GRPC_BIND_ADDRESS: "127.0.0.1:51051",
          AUDIT_PORT: "3201",
          AUDIT_GRPC_BIND_ADDRESS: "127.0.0.1:51068",
        }),
      ),
    ).toMatchObject({ httpPort: 3201, grpcBindAddress: "127.0.0.1:51068" });
  });

  it("starts without ALTER_SERVICE_NAME and still rejects the wrong one", () => {
    const withoutName = environment();
    delete withoutName.ALTER_SERVICE_NAME;
    expect(loadAuditEnvironment(withoutName)).toMatchObject({
      serviceName: "audit-service",
    });
    expect(() =>
      loadAuditEnvironment(environment({ ALTER_SERVICE_NAME: "model-gateway" })),
    ).toThrow(AuditConfigurationError);
  });

  it("uses the shared config source and ignores retired scoped overrides", () => {
    expect(
      loadAuditEnvironment(
        environment({
          ALTER_CONFIG_SOURCE: "appconfig",
          RUNTIME_MODE: "real",
          AUDIT_CONFIG_SOURCE: "local-file",
          ALTER_ENV: "prod",
          DATABASE_SECRET_REF: undefined,
          DATABASE_HOST: "db.internal",
          DATABASE_PORT: "5432",
          DATABASE_NAME: "audit_db",
          DATABASE_USER: "audit_service",
        }),
      ),
    ).toMatchObject({ configSource: "appconfig", runtimeMode: "real" });
  });

  it("defaults deployed environments to IAM database authentication metadata", () => {
    expect(
      loadAuditEnvironment(
        environment({
          ALTER_ENV: "prod",
          ALTER_CONFIG_SOURCE: "appconfig",
          DATABASE_SECRET_REF: undefined,
          DATABASE_HOST:
            "alter-prod-data.cluster-example.ap-south-1.rds.amazonaws.com",
          DATABASE_PORT: "5432",
          DATABASE_NAME: "audit_db",
          DATABASE_USER: "audit_service",
        }),
      ),
    ).toMatchObject({
      databaseAuthentication: "iam",
      databaseHost:
        "alter-prod-data.cluster-example.ap-south-1.rds.amazonaws.com",
      databasePort: 5432,
      databaseName: "audit_db",
      databaseUser: "audit_service",
    });
  });

  it.each([
    ["ALTER_ENV", { ALTER_ENV: "qa" }],
    ["ALTER_SERVICE_NAME", { ALTER_SERVICE_NAME: "audit" }],
    ["ALTER_REGION", { ALTER_REGION: "us-east-1" }],
    ["ALTER_CONFIG_SOURCE", { ALTER_CONFIG_SOURCE: "environment" }],
    ["DATABASE_SECRET_REF", { DATABASE_SECRET_REF: "" }],
    ["AUDIT_ARCHIVE_BUCKET_PARAM", { AUDIT_ARCHIVE_BUCKET_PARAM: "" }],
    ["AUDIT_CHAIN_SIGNING_KEY_REF", { AUDIT_CHAIN_SIGNING_KEY_REF: "" }],
    ["AUDIT_RETENTION_DATABASE_SECRET_REF", { AUDIT_RETENTION_DATABASE_SECRET_REF: "" }],
    ["PORT", { PORT: "0" }],
    ["GRPC_BIND_ADDRESS", { GRPC_BIND_ADDRESS: "localhost:50051" }],
    ["GRPC_BIND_ADDRESS", { GRPC_BIND_ADDRESS: "127.0.0.1:70000" }],
    [
      "DATABASE_HOST",
      {
        ALTER_ENV: "dev",
        DATABASE_HOST: "",
        DATABASE_PORT: "5432",
        DATABASE_NAME: "audit_db",
        DATABASE_USER: "audit_service",
      },
    ],
    [
      "DATABASE_PORT",
      {
        ALTER_ENV: "dev",
        DATABASE_HOST: "db.internal",
        DATABASE_PORT: "0",
        DATABASE_NAME: "audit_db",
        DATABASE_USER: "audit_service",
      },
    ],
    [
      "DATABASE_NAME",
      {
        ALTER_ENV: "dev",
        DATABASE_HOST: "db.internal",
        DATABASE_PORT: "5432",
        DATABASE_NAME: "",
        DATABASE_USER: "audit_service",
      },
    ],
    [
      "DATABASE_USER",
      {
        ALTER_ENV: "dev",
        DATABASE_HOST: "db.internal",
        DATABASE_PORT: "5432",
        DATABASE_NAME: "audit_db",
        DATABASE_USER: "",
      },
    ],
  ])("rejects invalid %s", (field, override) => {
    expect(() => loadAuditEnvironment(environment(override))).toThrow(
      AuditConfigurationError,
    );
    expect(() => loadAuditEnvironment(environment(override))).toThrow(field);
  });

  it("does not read a raw DATABASE_URL credential from environment", () => {
    const loaded = loadAuditEnvironment(
      environment({ DATABASE_URL: "postgresql://raw-credential.invalid/audit" }),
    );
    expect(loaded).not.toHaveProperty("databaseUrl");
  });
});

describe("database authentication selection", () => {
  // A Postgres container on EC2 has no AWS IAM authentication, so a deployed
  // environment must be able to ask for password (static) auth. IAM stays the default outside local so
  // no existing Aurora deployment changes behaviour by upgrading.
  const deployed = {
    ALTER_ENV: "staging",
    ALTER_SERVICE_NAME: "audit-service",
    ALTER_REGION: "ap-south-1",
    ALTER_CONFIG_SOURCE: "local-file",
    AUDIT_ARCHIVE_BUCKET_PARAM: "/alter/staging/audit/archive-bucket",
    ADS_DELETION_BASE_URL: "http://ads-core.internal:8000",
    ORCHESTRATION_DELETION_BASE_URL: "http://orchestration-service.internal:3000",
    PLATFORM_API_DELETION_BASE_URL: "http://platform-api.internal:3020",
    COST_DELETION_BASE_URL: "http://cost-ledger.internal:3000",
    INTELLIGENCE_DELETION_BASE_URL: "http://intelligence.internal:8000",
    EVAL_DELETION_BASE_URL: "http://eval.internal:8003",
    MEMORY_DELETION_BASE_URL: "http://memory.internal:8002",
    DELETION_PSEUDONYM_KEY_REF: "/alter/staging/audit-service/system/deletion-pseudonym-key",
    DELETION_SERVICE_TOKEN_REF: "/alter/staging/audit-service/system/deletion-service-token",
    AUDIT_CHAIN_SIGNING_KEY_REF: "/alter/staging/audit-service/chain-signing-key",
    AUDIT_RETENTION_DATABASE_SECRET_REF: "/alter/staging/audit-service/retention-database",
    DATABASE_HOST: "audit-db.internal",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "audit_db",
    DATABASE_USER: "audit_service",
  };

  it("still defaults a deployed environment to IAM", () => {
    expect(loadAuditEnvironment({ ...deployed })).toMatchObject({
      databaseAuthentication: "iam",
      databaseHost: "audit-db.internal",
    });
  });

  it("selects static auth when a deployed environment asks for it", () => {
    expect(
      loadAuditEnvironment({
        ...deployed,
        DATABASE_AUTHENTICATION: "static",
        DATABASE_SECRET_REF: "/alter/staging/audit-service/system/database_credentials",
      }),
    ).toMatchObject({
      databaseAuthentication: "static",
      databaseSecretReference: "/alter/staging/audit-service/system/database_credentials",
    });
  });

  it("requires the credential reference when static auth is selected", () => {
    expect(() =>
      loadAuditEnvironment({ ...deployed, DATABASE_AUTHENTICATION: "static" }),
    ).toThrow(AuditConfigurationError);
  });

  it("rejects an unknown authentication mode", () => {
    expect(() =>
      loadAuditEnvironment({ ...deployed, DATABASE_AUTHENTICATION: "password" }),
    ).toThrow(/must be static or iam/);
  });

  it("refuses IAM in the local environment, which has no signer", () => {
    expect(() =>
      loadAuditEnvironment(environment({ DATABASE_AUTHENTICATION: "iam" })),
    ).toThrow(/cannot be iam in the local environment/);
  });
});
