import { HttpException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTE_METADATA } from "./public-route";
import { SessionGatewayRateLimitGuard } from "./rate-limit.guard";
import type { ActorContext, IdentityTenantGatewayRequest } from "./types";

const ACTOR_A: ActorContext = {
  actor_type: "user",
  user_id: "usr_a",
  tenant_id: "ten_a",
  workspace_id: "ws_a",
  roles: [],
  permissions: [],
  session_id: null,
  jti: null,
};

function contextFor(
  request: IdentityTenantGatewayRequest,
  publicRoute = false,
): ExecutionContext {
  const handler = () => undefined;
  if (publicRoute) {
    Reflect.defineMetadata(PUBLIC_ROUTE_METADATA, true, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe("SessionGatewayRateLimitGuard", () => {
  it("bypasses rate limiting for public routes", () => {
    const guard = new SessionGatewayRateLimitGuard({ limitPerMinute: 1 });
    const request: IdentityTenantGatewayRequest = { headers: {}, url: "/v1/x" };

    expect(guard.canActivate(contextFor(request, true))).toBe(true);
    expect(guard.canActivate(contextFor(request, true))).toBe(true);
  });

  it("fails closed with 500 when actorContext is missing (guard ordering violated)", () => {
    const guard = new SessionGatewayRateLimitGuard();
    const request: IdentityTenantGatewayRequest = { headers: {}, url: "/v1/x" };

    expect(() => guard.canActivate(contextFor(request))).toThrow(
      HttpException,
    );
    try {
      guard.canActivate(contextFor(request));
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(500);
    }
  });

  it("allows requests under the limit and rejects the one that exceeds it", () => {
    const guard = new SessionGatewayRateLimitGuard({ limitPerMinute: 2 });
    const request: IdentityTenantGatewayRequest = {
      headers: {},
      url: "/v1/x",
      actorContext: ACTOR_A,
    };
    const context = contextFor(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });

  it("scopes limits independently per tenant", () => {
    const guard = new SessionGatewayRateLimitGuard({ limitPerMinute: 1 });
    const requestA: IdentityTenantGatewayRequest = {
      headers: {},
      url: "/v1/x",
      actorContext: ACTOR_A,
    };
    const requestB: IdentityTenantGatewayRequest = {
      headers: {},
      url: "/v1/x",
      actorContext: { ...ACTOR_A, tenant_id: "ten_b" },
    };

    expect(guard.canActivate(contextFor(requestA))).toBe(true);
    expect(guard.canActivate(contextFor(requestB))).toBe(true);
    expect(() => guard.canActivate(contextFor(requestA))).toThrow(
      HttpException,
    );
  });

  it("resets the window after it elapses", () => {
    let nowMs = 0;
    const guard = new SessionGatewayRateLimitGuard({
      limitPerMinute: 1,
      now: () => new Date(nowMs),
    });
    const request: IdentityTenantGatewayRequest = {
      headers: {},
      url: "/v1/x",
      actorContext: ACTOR_A,
    };
    const context = contextFor(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    nowMs += 60_001;
    expect(guard.canActivate(context)).toBe(true);
  });

  it("bounds tracked-tenant memory by evicting the oldest bucket at capacity", () => {
    let nowMs = 0;
    const guard = new SessionGatewayRateLimitGuard({
      limitPerMinute: 1,
      maxTrackedTenants: 2,
      now: () => new Date(nowMs),
    });
    const requestFor = (tenantId: string): IdentityTenantGatewayRequest => ({
      headers: {},
      url: "/v1/x",
      actorContext: { ...ACTOR_A, tenant_id: tenantId },
    });

    expect(guard.canActivate(contextFor(requestFor("ten_1")))).toBe(true);
    nowMs += 1;
    expect(guard.canActivate(contextFor(requestFor("ten_2")))).toBe(true);
    nowMs += 1;
    // Adding a third tenant while at capacity must evict the oldest bucket
    // (ten_1) rather than growing the map forever.
    expect(guard.canActivate(contextFor(requestFor("ten_3")))).toBe(true);

    // ten_1's bucket was evicted, so it gets a fresh window instead of
    // being rate-limited by state that should have been forgotten.
    expect(guard.canActivate(contextFor(requestFor("ten_1")))).toBe(true);
  });
});
