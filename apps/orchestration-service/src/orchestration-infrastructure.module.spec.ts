import { describe, expect, it } from "vitest";

import { resolveDatabaseAuthentication } from "./orchestration-infrastructure.module";

/**
 * A Postgres container has no AWS IAM authentication, so a deployed
 * orchestration-service must be able to reach its database with a password. IAM stays the default outside
 * local, so an existing Aurora deployment is unaffected; static is only ever
 * chosen because a deployment asked for it, never inferred.
 */
describe("resolveDatabaseAuthentication", () => {
  it("defaults a deployed environment to IAM", () => {
    expect(resolveDatabaseAuthentication({ ALTER_ENV: "staging" })).toBe("iam");
  });

  it("selects static when a deployed environment asks for it", () => {
    expect(
      resolveDatabaseAuthentication({
        ALTER_ENV: "staging",
        DATABASE_AUTHENTICATION: "static",
      }),
    ).toBe("static");
  });

  it("lets the service-scoped variable win over the shared one", () => {
    expect(
      resolveDatabaseAuthentication({
        ALTER_ENV: "staging",
        ORCHESTRATION_DATABASE_AUTHENTICATION: "static",
        DATABASE_AUTHENTICATION: "iam",
      }),
    ).toBe("static");
  });

  it("keeps local on static", () => {
    expect(resolveDatabaseAuthentication({ ALTER_ENV: "local" })).toBe("static");
  });

  it("refuses IAM locally, where no signer exists", () => {
    expect(() =>
      resolveDatabaseAuthentication({ ALTER_ENV: "local", DATABASE_AUTHENTICATION: "iam" }),
    ).toThrow(/cannot be iam in the local environment/);
  });

  it("rejects an unknown mode rather than falling back", () => {
    expect(() =>
      resolveDatabaseAuthentication({ ALTER_ENV: "staging", DATABASE_AUTHENTICATION: "password" }),
    ).toThrow(/must be static or iam/);
  });
});
