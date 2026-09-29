import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  actorClaims,
  jwksFetch,
  mintJwt,
  TEST_NOW,
  TEST_TENANT,
  TEST_USER,
  TEST_WORKSPACE,
  testSigningKey,
  type TestSigningKey,
} from "../test-utils/jwt-fixture";
import { ActorTokenValidator } from "./actor-token-validator";
import type { ReplayStore } from "./types";

let key: TestSigningKey;

beforeAll(() => {
  key = testSigningKey();
});

function setup(replayResult = true) {
  const replayStore: ReplayStore = {
    setIfAbsent: vi.fn().mockResolvedValue(replayResult),
  };
  return {
    replayStore,
    validator: new ActorTokenValidator(
      {
        issuer: "alter-platform-api.identity-broker",
        audience: "alter-engine",
        jwksUrl: "https://identity.example.test/actor-jwks",
      },
      replayStore,
      { fetch: jwksFetch(key), nowSeconds: () => TEST_NOW },
    ),
  };
}

describe("ActorTokenValidator", () => {
  it("validates a conformant token and builds user context", async () => {
    const { validator, replayStore } = setup();
    const result = await validator.validate(mintJwt(actorClaims(), key));
    expect(result.actorContext).toEqual({
      actor_type: "user",
      user_id: TEST_USER,
      tenant_id: TEST_TENANT,
      workspace_id: TEST_WORKSPACE,
      roles: ["member"],
      permissions: ["workflow:read"],
      session_id: "session-test",
      jti: "jti-test",
    });
    expect(replayStore.setIfAbsent).toHaveBeenCalledWith(
      "blackboard:actor_jti:jti-test",
      300,
    );
  });

  it("rejects a token whose lifetime exceeds five minutes", async () => {
    const { validator } = setup();
    await expect(
      validator.validate(
        mintJwt(actorClaims({ exp: TEST_NOW + 301 }), key),
      ),
    ).rejects.toMatchObject({
      errorCode: "AUTH_ACTOR_TOKEN_LIFETIME_EXCEEDED",
    });
  });

  it("rejects an expired token", async () => {
    const { validator } = setup();
    await expect(
      validator.validate(
        mintJwt(actorClaims({ iat: TEST_NOW - 300, exp: TEST_NOW }), key),
      ),
    ).rejects.toMatchObject({ errorCode: "AUTH_ACTOR_TOKEN_EXPIRED" });
  });

  it("rejects replay on the second use", async () => {
    const { validator } = setup(false);
    await expect(
      validator.validate(mintJwt(actorClaims(), key)),
    ).rejects.toMatchObject({ errorCode: "AUTH_ACTOR_TOKEN_REPLAY" });
  });

  it.each([
    ["wrong issuer", { iss: "other" }],
    ["wrong audience", { aud: "other" }],
    ["malformed claims", { tenant_id: "tenant-a" }],
  ])("rejects %s", async (_name, override) => {
    const { validator } = setup();
    await expect(
      validator.validate(mintJwt(actorClaims(override), key)),
    ).rejects.toMatchObject({ errorCode: "AUTH_INVALID_ACTOR_TOKEN" });
  });

  it("rejects bad signatures", async () => {
    const { validator } = setup();
    const wrongKey = testSigningKey(key.kid);
    await expect(
      validator.validate(mintJwt(actorClaims(), wrongKey)),
    ).rejects.toMatchObject({ errorCode: "AUTH_INVALID_ACTOR_TOKEN" });
  });

  it("rejects non-integer registered times as malformed", async () => {
    const { validator } = setup();
    await expect(
      validator.validate(
        mintJwt({ ...actorClaims(), iat: TEST_NOW + 0.5 }, key),
      ),
    ).rejects.toMatchObject({ errorCode: "AUTH_INVALID_ACTOR_TOKEN" });
  });

  describe("system principal (D1)", () => {
    const systemClaims = (overrides: Record<string, unknown> = {}) => ({
      principal_type: "system",
      principal: "system:platform-jobs",
      tenant_id: TEST_TENANT,
      permissions: ["runs:read", "billing:read"],
      auth_time: TEST_NOW - 60,
      jti: "jti-system",
      iss: "alter-platform-api.identity-broker",
      aud: "alter-engine",
      iat: TEST_NOW,
      exp: TEST_NOW + 300,
      ...overrides,
    });

    it("accepts a system token and builds a system context with no user and no workspace", async () => {
      const { validator, replayStore } = setup();
      const result = await validator.validate(mintJwt(systemClaims(), key));
      expect(result.actorContext).toEqual({
        actor_type: "system",
        user_id: null,
        tenant_id: TEST_TENANT,
        workspace_id: null,
        roles: ["system:platform-jobs"],
        permissions: ["runs:read", "billing:read"],
        session_id: null,
        jti: "jti-system",
      });
      expect(replayStore.setIfAbsent).toHaveBeenCalledWith(
        "blackboard:actor_jti:jti-system",
        300,
      );
    });

    it("is single-use like every actor token", async () => {
      const { validator } = setup(false);
      await expect(
        validator.validate(mintJwt(systemClaims(), key)),
      ).rejects.toMatchObject({ errorCode: "AUTH_ACTOR_TOKEN_REPLAY" });
    });

    it.each([
      ["a write permission", { permissions: ["runs:read", "workflows:write"] }],
      ["a different principal", { principal: "system:other" }],
      ["a user id beside the system marker", { user_id: TEST_USER }],
      ["no tenant", { tenant_id: undefined }],
    ])("refuses %s", async (_name, override) => {
      const { validator, replayStore } = setup();
      await expect(
        validator.validate(mintJwt(systemClaims(override), key)),
      ).rejects.toMatchObject({ errorCode: "AUTH_INVALID_ACTOR_TOKEN" });
      expect(replayStore.setIfAbsent).not.toHaveBeenCalled();
    });

    it("refuses a user token that claims to be a system principal", async () => {
      const { validator } = setup();
      await expect(
        validator.validate(
          mintJwt({ ...actorClaims(), principal_type: "system" }, key),
        ),
      ).rejects.toMatchObject({ errorCode: "AUTH_INVALID_ACTOR_TOKEN" });
    });
  });
});
