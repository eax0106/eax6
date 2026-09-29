import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { ActorTokenValidator } from "@alterx/auth";
import { describe, expect, it, vi } from "vitest";
import { ActionCentreService } from "../action-centre/action-centre.service";
import type { EngineClient } from "../engine/engine-client";
import type { EngineCallerContext } from "../engine/types";
import { CachedEngineResourceLookup } from "../rbac/param-workspace.resolver";
import type { ActorContext } from "../rbac/types";
import { IdentityBrokerEngineAuthProvider } from "../engine/auth";
import { createSystemCallerContext } from "../system-jobs/system-caller";
import { IdentityBrokerService } from "./identity-broker.service";

/**
 * The engine accepts a platform-api call only if the actor token minted for
 * it passes the engine's ActorTokenValidator. These tests take the caller
 * context platform-api really builds for a call, mint it with the real
 * identity broker and validate it the way orchestration-service does, so a
 * context the engine would reject fails here instead of in production.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const broker = new IdentityBrokerService("actor-signing-key", {
  resolvePrivateKey: async () => privatePem,
  resolvePublicKey: async () =>
    createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString(),
});

// Platform ids are UUIDv7 since signup moved to uuidv7().
const approver: ActorContext = {
  user_id: "019a1b2c-3d4e-7f50-8a61-72839405a6b1",
  tenant_id: "019a1b2c-3d4e-7f50-8a61-72839405a6b2",
  workspace_id: "019a1b2c-3d4e-7f50-8a61-72839405a6b3",
  roles: ["owner", "admin"],
  permissions: ["approvals:decide"],
  session_id: "sess_019a1b2c",
  auth_time: 1_789_000_000,
};
const approvalId = "apr_019a1b2c-3d4e-7f50-8a61-72839405a6b4";

async function engineAccepts(context: EngineCallerContext) {
  const jwks = await broker.publicJwks();
  const seen = new Set<string>();
  const validator = new ActorTokenValidator(
    { issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://platform.test/jwks" },
    { setIfAbsent: async (key: string) => (seen.has(key) ? false : (seen.add(key), true)) },
    { fetch: (async () => ({ ok: true, json: async () => jwks })) as never },
  );
  const minted = await broker.mintActorToken({ ...context, callingTenantId: context.tenantId });
  return validator.validate(minted.token);
}

async function engineValidator() {
  const jwks = await broker.publicJwks();
  const seen = new Set<string>();
  return new ActorTokenValidator(
    { issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl: "https://platform.test/jwks" },
    { setIfAbsent: async (key: string) => (seen.has(key) ? false : (seen.add(key), true)) },
    { fetch: (async () => ({ ok: true, json: async () => jwks })) as never },
  );
}

function capturingEngine() {
  const contexts: EngineCallerContext[] = [];
  const record = vi.fn(async (_path: string, ...args: unknown[]) => {
    contexts.push(args.find((arg) => typeof arg === "object" && arg !== null && "tenantId" in arg) as EngineCallerContext);
    return { status: 200, body: { workspace_id: approver.workspace_id } };
  });
  return { contexts, engine: { get: record, post: record } as unknown as EngineClient };
}

describe("actor tokens platform-api mints for the engine", () => {
  it("are accepted for the RBAC workspace lookup an approval runs first", async () => {
    const { contexts, engine } = capturingEngine();
    const lookup = new CachedEngineResourceLookup(engine, (id) => `/api/v1/approvals/${id}`, (body) =>
      typeof body.workspace_id === "string" ? body.workspace_id : undefined,
    );

    await lookup.getWorkspaceId(approver, approvalId);

    const accepted = await engineAccepts(contexts[0]!);
    expect(accepted.actorContext).toMatchObject({
      user_id: `usr_${approver.user_id}`,
      tenant_id: `ten_${approver.tenant_id}`,
      workspace_id: `ws_${approver.workspace_id}`,
    });
  });

  it("are accepted for the approve call itself", async () => {
    const { contexts, engine } = capturingEngine();

    await new ActionCentreService(engine).decideApproval(approvalId, "approve", {}, approver, undefined, "idem-1");

    const accepted = await engineAccepts(contexts[0]!);
    expect(accepted.actorContext.permissions).toEqual(["approvals:decide"]);
  });

  it("reject the empty identity the workspace lookup used to send", async () => {
    await expect(
      engineAccepts({
        userId: "",
        tenantId: approver.tenant_id,
        workspaceId: "",
        sessionId: "",
        authTime: 0,
        roles: [],
        permissions: [],
        traceparent: "",
      }),
    ).rejects.toThrow("AUTH_INVALID_ACTOR_TOKEN");
  });
});

describe("the system caller's actor token (D1)", () => {
  const tenantUuid = "019a1b2c-3d4e-7f50-8a61-72839405a6b2";

  it("is accepted by the engine's validator as a read-only system actor with no user and no workspace", async () => {
    const provider = new IdentityBrokerEngineAuthProvider(broker, { getAccessToken: async () => "m2m" });
    const { actorToken } = await provider.authorize(
      createSystemCallerContext({ tenantId: tenantUuid, traceparent: "00-a-b-01" }),
    );

    const accepted = await (await engineValidator()).validate(actorToken);

    expect(accepted.actorContext).toMatchObject({
      actor_type: "system",
      user_id: null,
      workspace_id: null,
      tenant_id: `ten_${tenantUuid}`,
      roles: ["system:platform-jobs"],
    });
    expect(accepted.actorContext.permissions.every((p) => p.endsWith(":read"))).toBe(true);
  });

  it("is single-use: the engine refuses a second presentation", async () => {
    const provider = new IdentityBrokerEngineAuthProvider(broker, { getAccessToken: async () => "m2m" });
    const { actorToken } = await provider.authorize(
      createSystemCallerContext({ tenantId: tenantUuid, traceparent: "00-a-b-01" }),
    );
    const validator = await engineValidator();

    await validator.validate(actorToken);
    await expect(validator.validate(actorToken)).rejects.toThrow("AUTH_ACTOR_TOKEN_REPLAY");
  });
});
