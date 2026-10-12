import { afterEach, describe, expect, it } from "vitest";
import { resolveEmailProvider } from "./resolve-email-provider";
import type { SecretResolver } from "./ses-email-provider";

// Relocated from
// apps/platform-api/src/notifications/notification.module.spec.ts --
// same 4 cases, unchanged, alongside the function's new home. The secret
// resolver these tests pass is never actually invoked: the mock path
// never calls it, and the real-SES-provider path only calls it lazily
// on the provider's first send, which none of these tests trigger --
// matching the original tests' own scope (they only checked which
// provider gets constructed, not a real SES round trip).
const unusedResolveSecret: SecretResolver = async () => {
  throw new Error("not expected to be called");
};

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("resolveEmailProvider", () => {
  it("defaults to the mock provider outside production", () => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.NODE_ENV;
    expect(resolveEmailProvider(unusedResolveSecret).metadata.providerId).toBe("mock-email");
  });

  it("refuses to serve mock email when NODE_ENV=production", () => {
    delete process.env.EMAIL_PROVIDER;
    process.env.NODE_ENV = "production";
    expect(() => resolveEmailProvider(unusedResolveSecret)).toThrow(
      "EMAIL_PROVIDER=mock is not allowed when NODE_ENV=production",
    );
  });

  it("fails closed instead of silently falling back to mock when EMAIL_PROVIDER=ses is missing credentials", () => {
    process.env.EMAIL_PROVIDER = "ses";
    delete process.env.SES_FROM_ADDRESS;
    delete process.env.SES_CREDENTIALS_SECRET_REF;
    expect(() => resolveEmailProvider(unusedResolveSecret)).toThrow(
      "SES_FROM_ADDRESS and SES_CREDENTIALS_SECRET_REF are required when EMAIL_PROVIDER=ses",
    );
  });

  it("builds the real SES provider when explicitly selected with credentials", () => {
    process.env.EMAIL_PROVIDER = "ses";
    process.env.SES_FROM_ADDRESS = "no-reply@alter.test";
    process.env.SES_CREDENTIALS_SECRET_REF = "env:SES_CREDENTIALS";
    const provider = resolveEmailProvider(unusedResolveSecret);
    expect(provider.metadata.providerId).toBe("aws-ses");
  });

  it("uses the default AWS credentials only when asked to, and never in production", () => {
    const environment = { EMAIL_PROVIDER: "ses", SES_FROM_ADDRESS: "no-reply@alter.test", SES_USE_DEFAULT_CREDENTIALS: "true" };
    expect(resolveEmailProvider(unusedResolveSecret, environment).metadata.providerId).toBe("aws-ses");
    expect(() => resolveEmailProvider(unusedResolveSecret, { ...environment, SES_USE_DEFAULT_CREDENTIALS: "1" })).toThrow(
      "SES_FROM_ADDRESS and SES_CREDENTIALS_SECRET_REF are required when EMAIL_PROVIDER=ses",
    );
    expect(() => resolveEmailProvider(unusedResolveSecret, { ...environment, NODE_ENV: "production" })).toThrow(
      "SES_USE_DEFAULT_CREDENTIALS is not allowed when NODE_ENV=production",
    );
  });
});
