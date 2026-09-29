import { describe, expect, it } from "vitest";
import {
  ActorTokenClaimsSchema,
  SYSTEM_PLATFORM_JOBS_PERMISSIONS,
  SystemActorTokenClaimsSchema,
} from "./actor-token";
import { ids } from "./test-fixtures";

const validClaims = {
  user_id: ids.user,
  tenant_id: ids.tenant,
  workspace_id: ids.workspace,
  roles: ["operator"],
  permissions: ["runs:start"],
  session_id: "session-42",
  auth_time: 1_750_000_000,
  jti: "jwt-42",
  iss: "alter-identity-broker",
  aud: "alter-engine",
  iat: 1_750_000_010,
  exp: 1_750_000_310,
};

describe("ActorTokenClaimsSchema", () => {
  it("contains exactly the 12 Alter-owned delegation claims", () => {
    expect(Object.keys(ActorTokenClaimsSchema.shape)).toEqual([
      "user_id",
      "tenant_id",
      "workspace_id",
      "roles",
      "permissions",
      "session_id",
      "auth_time",
      "jti",
      "iss",
      "aud",
      "iat",
      "exp",
    ]);
  });

  it("accepts a human actor token with a five-minute lifetime", () => {
    expect(ActorTokenClaimsSchema.parse(validClaims)).toEqual(validClaims);
  });

  it("accepts a service actor without fabricating a human user", () => {
    expect(
      ActorTokenClaimsSchema.safeParse({
        ...validClaims,
        user_id: "svc_event-gateway",
      }).success,
    ).toBe(true);
  });

  it("rejects delegation tokens longer than five minutes", () => {
    expect(
      ActorTokenClaimsSchema.safeParse({
        ...validClaims,
        exp: validClaims.iat + 301,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing required claim", () => {
    const withoutJti = { ...validClaims, jti: undefined };
    expect(ActorTokenClaimsSchema.safeParse(withoutJti).success).toBe(false);
  });
});

describe("SystemActorTokenClaimsSchema", () => {
  const systemClaims = {
    principal_type: "system",
    principal: "system:platform-jobs",
    tenant_id: ids.tenant,
    permissions: ["runs:read", "billing:read"],
    auth_time: 1_750_000_000,
    jti: "jwt-sys-1",
    iss: "alter-identity-broker",
    aud: "alter-engine",
    iat: 1_750_000_010,
    exp: 1_750_000_310,
  };

  it("accepts a one-tenant, read-only system token with no user and no workspace", () => {
    expect(SystemActorTokenClaimsSchema.parse(systemClaims)).toEqual(systemClaims);
  });

  it("holds only read permissions", () => {
    expect(SYSTEM_PLATFORM_JOBS_PERMISSIONS.every((p) => p.endsWith(":read"))).toBe(true);
  });

  it.each([
    ["a write permission", { permissions: ["workflows:write"] }],
    ["an approval decision", { permissions: ["approvals:decide"] }],
    ["no permissions at all", { permissions: [] }],
    ["another principal", { principal: "system:other" }],
    ["a user id", { user_id: ids.user }],
    ["a workspace", { workspace_id: ids.workspace }],
    ["a lifetime over five minutes", { exp: 1_750_000_311 }],
    ["a tenant that is not prefixed", { tenant_id: "not-a-tenant" }],
  ])("rejects %s", (_name, override) => {
    expect(SystemActorTokenClaimsSchema.safeParse({ ...systemClaims, ...override }).success).toBe(false);
  });

  it("is not accepted by the user schema, and a user token is not accepted here", () => {
    expect(ActorTokenClaimsSchema.safeParse(systemClaims).success).toBe(false);
    expect(SystemActorTokenClaimsSchema.safeParse(validClaims).success).toBe(false);
  });
});
