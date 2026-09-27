import { describe, expect, it } from "vitest";

import {
  CostLedgerConfigurationError,
  loadCostLedgerEnvironment,
} from "./environment";

const baseEnvironment = {
  ALTER_ENV: "local",
  ALTER_SERVICE_NAME: "cost-ledger-service",
  DATABASE_SECRET_REF: "secret://cost-ledger/local",
  COST_PSEUDONYM_KEY_REF: "secret://cost-ledger/pseudonym",
};

describe("loadCostLedgerEnvironment", () => {
  it("uses the disclosed INR conversion placeholder for new cost ingestion", () => {
    expect(loadCostLedgerEnvironment(baseEnvironment).costUsdToInrRate).toBe(83);
    expect(
      loadCostLedgerEnvironment({
        ...baseEnvironment,
        COST_USD_TO_INR_RATE: "84.25",
      }).costUsdToInrRate,
    ).toBe(84.25);
  });

  it("fails startup for an invalid INR conversion rate", () => {
    expect(() =>
      loadCostLedgerEnvironment({
        ...baseEnvironment,
        COST_USD_TO_INR_RATE: "0",
      }),
    ).toThrow(CostLedgerConfigurationError);
  });
});

describe("database authentication selection", () => {
  // Same rule as audit-service: IAM stays the default outside local, and a
  // target without AWS IAM (Neon) asks for password auth explicitly.
  const deployed = {
    ALTER_ENV: "staging",
    ALTER_SERVICE_NAME: "cost-ledger-service",
    ALTER_REGION: "ap-south-1",
    COST_PSEUDONYM_KEY_REF: "secret://cost-ledger/pseudonym",
    DATABASE_HOST: "cost-db.internal",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "cost_db",
    DATABASE_USER: "cost_ledger_service",
  };

  it("still defaults a deployed environment to IAM", () => {
    expect(loadCostLedgerEnvironment({ ...deployed })).toMatchObject({
      databaseAuthentication: "iam",
      databaseHost: "cost-db.internal",
    });
  });

  it("selects static auth when a deployed environment asks for it", () => {
    expect(
      loadCostLedgerEnvironment({
        ...deployed,
        DATABASE_AUTHENTICATION: "static",
        DATABASE_SECRET_REF: "secret://cost-ledger/staging",
      }),
    ).toMatchObject({
      databaseAuthentication: "static",
      databaseSecretReference: "secret://cost-ledger/staging",
    });
  });

  it("requires the credential reference when static auth is selected", () => {
    expect(() =>
      loadCostLedgerEnvironment({ ...deployed, DATABASE_AUTHENTICATION: "static" }),
    ).toThrow(CostLedgerConfigurationError);
  });

  it("rejects an unknown authentication mode", () => {
    expect(() =>
      loadCostLedgerEnvironment({ ...deployed, DATABASE_AUTHENTICATION: "password" }),
    ).toThrow(/must be static or iam/);
  });

  it("refuses IAM in the local environment", () => {
    expect(() =>
      loadCostLedgerEnvironment({ ...baseEnvironment, DATABASE_AUTHENTICATION: "iam" }),
    ).toThrow(/cannot be iam in the local environment/);
  });
});
