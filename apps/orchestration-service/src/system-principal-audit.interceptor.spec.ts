import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { ActorContext } from "@alterx/auth";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { lastValueFrom, of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { SystemPrincipalAuditInterceptor } from "./system-principal-audit.interceptor";

const actor = (overrides: Partial<ActorContext>): ActorContext => ({
  actor_type: "system",
  user_id: null,
  tenant_id: "ten_00000000-0000-7000-8000-000000000001",
  workspace_id: null,
  roles: ["system:platform-jobs"],
  permissions: ["runs:read"],
  session_id: null,
  jti: "jti-1",
  ...overrides,
});

function context(request: Record<string, unknown>, type = "http"): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function setup(recordEvent = vi.fn().mockResolvedValue(undefined)) {
  const audit = { recordEvent } as unknown as AuditEventHandler;
  return { recordEvent, interceptor: new SystemPrincipalAuditInterceptor(audit) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SystemPrincipalAuditInterceptor", () => {
  it("records a system read with its principal type, tenant and route pattern, never the query", async () => {
    const { interceptor, recordEvent } = setup();
    const request = {
      actorContext: actor({}),
      method: "GET",
      url: "/api/v1/runs?limit=5&q=secret",
      routeOptions: { url: "/api/v1/runs" },
    };

    await lastValueFrom(
      interceptor.intercept(context(request), { handle: () => of("ok") } as CallHandler),
    );
    await flush();

    expect(recordEvent).toHaveBeenCalledTimes(1);
    const event = recordEvent.mock.calls[0]![0];
    expect(event).toMatchObject({
      tenant_id: "ten_00000000-0000-7000-8000-000000000001",
      actor_type: "system",
      actor_ref: "system:platform-jobs",
      action: "system.read",
      target_type: "route",
      target_ref: "GET /api/v1/runs",
      result: "success",
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    // Only keys audit-service allows (ip_class, request_id, scope); it rejects any other.
    expect(JSON.parse(event.context_json)).toEqual({ scope: "system_read", request_id: "jti-1" });
  });

  it("falls back to the url without its query string when no route pattern is known", async () => {
    const { interceptor, recordEvent } = setup();
    await lastValueFrom(
      interceptor.intercept(
        context({ actorContext: actor({}), method: "GET", url: "/api/v1/runs/run_1?x=1" }),
        { handle: () => of(1) } as CallHandler,
      ),
    );
    await flush();
    expect(recordEvent.mock.calls[0]![0].target_ref).toBe("GET /api/v1/runs/run_1");
  });

  it("records a failed read as an error and still lets the failure through", async () => {
    const { interceptor, recordEvent } = setup();
    await expect(
      lastValueFrom(
        interceptor.intercept(
          context({ actorContext: actor({}), method: "GET", url: "/api/v1/runs" }),
          { handle: () => throwError(() => new Error("boom")) } as CallHandler,
        ),
      ),
    ).rejects.toThrow("boom");
    await flush();
    expect(recordEvent.mock.calls[0]![0]).toMatchObject({ result: "error", actor_type: "system" });
  });

  it.each([
    ["a user", actor({ actor_type: "user", user_id: "usr_1" })],
    ["a service", actor({ actor_type: "service" })],
  ])("records nothing for %s", async (_name, who) => {
    const { interceptor, recordEvent } = setup();
    await lastValueFrom(
      interceptor.intercept(
        context({ actorContext: who, method: "GET", url: "/api/v1/runs" }),
        { handle: () => of(1) } as CallHandler,
      ),
    );
    await flush();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("does not touch non-http contexts", async () => {
    const { interceptor, recordEvent } = setup();
    await lastValueFrom(
      interceptor.intercept(context({}, "rpc"), { handle: () => of(1) } as CallHandler),
    );
    await flush();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("an audit outage never fails the read", async () => {
    const { interceptor, recordEvent } = setup(vi.fn().mockRejectedValue(new Error("audit down")));
    await expect(
      lastValueFrom(
        interceptor.intercept(
          context({ actorContext: actor({}), method: "GET", url: "/api/v1/runs" }),
          { handle: () => of("still ok") } as CallHandler,
        ),
      ),
    ).resolves.toBe("still ok");
    await flush();
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });
});
