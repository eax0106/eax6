import { generateKeyPairSync } from "node:crypto";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityBrokerModule } from "./identity-broker.module";
import { IdentityBrokerService } from "./identity-broker.service";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("IdentityBrokerModule", () => {
  it("resolves and validates the persisted signing key during module creation", async () => {
    configureBaseEnvironment();
    process.env.ACTOR_TOKEN_SIGNING_KEY_REF = "env:ACTOR_TOKEN_PRIVATE_KEY";
    process.env.ACTOR_TOKEN_PRIVATE_KEY = privateKey();

    const moduleRef = await Test.createTestingModule({ imports: [IdentityBrokerModule] }).compile();
    expect(moduleRef.get(IdentityBrokerService)).toBeInstanceOf(IdentityBrokerService);
    await moduleRef.close();
  });

  it("fails module creation when the secret reference cannot resolve", async () => {
    configureBaseEnvironment();
    process.env.ACTOR_TOKEN_SIGNING_KEY_REF = "env:MISSING_PRIVATE_KEY";
    delete process.env.MISSING_PRIVATE_KEY;

    await expect(
      Test.createTestingModule({ imports: [IdentityBrokerModule] }).compile(),
    ).rejects.toThrow("Secret reference unavailable");
  });

  it("allows generated keys only with explicit mock mode in tests", async () => {
    configureBaseEnvironment();
    process.env.NODE_ENV = "test";
    process.env.SIGNING_KEY_PROVIDER = "mock";
    delete process.env.ACTOR_TOKEN_SIGNING_KEY_REF;

    const moduleRef = await Test.createTestingModule({ imports: [IdentityBrokerModule] }).compile();
    expect(moduleRef.get(IdentityBrokerService)).toBeInstanceOf(IdentityBrokerService);
    await moduleRef.close();

    process.env.NODE_ENV = "production";
    process.env.RUNTIME_MODE = "real";
    await expect(
      Test.createTestingModule({ imports: [IdentityBrokerModule] }).compile(),
    ).rejects.toThrow("Mock signing keys are restricted to NODE_ENV=test");
  });
});

function configureBaseEnvironment(): void {
  process.env.PLATFORM_RETENTION_DATABASE_URL = "postgres://platform_retention:fixture-only@localhost:5432/platform_db";
  process.env.DATABASE_URL =
    "postgres://platform_api:platform_api_local@localhost:5432/platform_db";
  process.env.MARKETPLACE_DATABASE_URL =
    "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db";
  process.env.SIGNING_KEY_PROVIDER = "secrets";
}

function privateKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}
