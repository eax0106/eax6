import { describe, expect, it } from "vitest";
import { engineConfigFromEnvironment } from "./config";

describe("engineConfigFromEnvironment", () => {
  it("validates config and applies bounded timeout default", () => {
    expect(
      engineConfigFromEnvironment({
        ENGINE_BASE_URL: "https://engine.test/",
        ADS_CORE_BASE_URL: "https://ads.test/",
        COST_LEDGER_BASE_URL: "https://costs.test/",
        EVAL_FACADE_TOKEN_REF: "env:EVAL_FACADE_TOKEN",
        DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "env:DEPLOYMENT_ADMIN_TOKEN",
        AUDIT_SERVICE_BASE_URL: "https://audit.test/",
        AUDIT_QUERY_SERVICE_TOKEN_REF: "env:AUDIT_QUERY_TOKEN",
        ENGINE_M2M_TOKEN_URL: "https://identity.test/oauth/token",
        ENGINE_M2M_AUDIENCE: "https://engine.test",
        ENGINE_M2M_CLIENT_ID: "platform-api",
        ENGINE_M2M_CLIENT_SECRET_REF: "env:ENGINE_SECRET",
      }),
    ).toEqual({
      baseUrl: "https://engine.test",
      adsCoreBaseUrl: "https://ads.test",
      costLedgerBaseUrl: "https://costs.test",
      evalFacadeTokenRef: "env:EVAL_FACADE_TOKEN",
      deploymentAdminServiceTokenRef: "env:DEPLOYMENT_ADMIN_TOKEN",
      auditServiceBaseUrl: "https://audit.test",
      auditQueryServiceTokenRef: "env:AUDIT_QUERY_TOKEN",
      m2mTokenUrl: "https://identity.test/oauth/token",
      m2mAudience: "https://engine.test",
      m2mClientId: "platform-api",
      m2mClientSecretRef: "env:ENGINE_SECRET",
      requestTimeoutMs: 5_000,
      planningTimeoutMs: 120_000,
    });
  });

  it("requires the ads-core service token reference in production only", () => {
    const base = {
      ENGINE_BASE_URL: "https://engine.test",
      ADS_CORE_BASE_URL: "https://ads.test",
      COST_LEDGER_BASE_URL: "https://costs.test",
      EVAL_FACADE_TOKEN_REF: "env:EVAL_FACADE_TOKEN",
      DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "env:DEPLOYMENT_ADMIN_TOKEN",
      AUDIT_SERVICE_BASE_URL: "https://audit.test",
      AUDIT_QUERY_SERVICE_TOKEN_REF: "env:AUDIT_QUERY_TOKEN",
      ENGINE_M2M_TOKEN_URL: "https://identity.test/oauth/token",
      ENGINE_M2M_AUDIENCE: "https://engine.test",
      ENGINE_M2M_CLIENT_ID: "platform-api",
      ENGINE_M2M_CLIENT_SECRET_REF: "env:ENGINE_SECRET",
    };
    expect(() => engineConfigFromEnvironment({ ...base, NODE_ENV: "production" })).toThrow(
      "ADS_CORE_SERVICE_TOKEN_REF is required in production",
    );
    expect(
      engineConfigFromEnvironment({
        ...base,
        NODE_ENV: "production",
        ADS_CORE_SERVICE_TOKEN_REF: "env:INTERNAL_SERVICE_TOKEN",
      }).adsCoreServiceTokenRef,
    ).toBe("env:INTERNAL_SERVICE_TOKEN");
    expect(engineConfigFromEnvironment(base).adsCoreServiceTokenRef).toBeUndefined();
  });

  it("fails loud when required Engine config is missing", () => {
    expect(() => engineConfigFromEnvironment({})).toThrow(
      "Invalid Engine client environment",
    );
  });
});
