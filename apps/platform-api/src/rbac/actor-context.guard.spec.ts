import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ActorContextGuard } from "./actor-context.guard";
import type { IdentityService } from "../identity/identity.service";
import type { PlatformDb } from "../signup/platform-db";
import type { RbacRequest } from "./types";

const session = {
  id: "sess_00000000-0000-7000-8000-000000000301",
  userId: "usr_00000000-0000-7000-8000-000000000201",
  tenantId: "ten_00000000-0000-7000-8000-000000000001",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastSeenAt: new Date("2026-01-01T00:00:00Z"),
};

function contextWithCookie(cookie: string | undefined): {
  context: ExecutionContext;
  request: RbacRequest & { headers: { cookie?: string } };
} {
  const request: RbacRequest & { headers: { cookie?: string } } = {
    headers: cookie === undefined ? {} : { cookie },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("ActorContextGuard", () => {
  it("leaves actorContext unset and returns true when no access-token cookie is present", async () => {
    const identityService = { authenticateAccessToken: vi.fn() };
    const db = { queryTenant: vi.fn() };
    const guard = new ActorContextGuard(
      identityService as unknown as IdentityService,
      db as unknown as PlatformDb,
    );
    const { context, request } = contextWithCookie(undefined);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actorContext).toBeUndefined();
    expect(identityService.authenticateAccessToken).not.toHaveBeenCalled();
  });

  it("populates actorContext with a resolved workspace_id when a workspace role exists", async () => {
    const identityService = {
      authenticateAccessToken: vi.fn().mockResolvedValue(session),
    };
    const db = {
      queryTenant: vi
        .fn()
        .mockResolvedValueOnce([{ role: "member", workspaceId: null }])
        .mockResolvedValueOnce([{ role: "editor", workspaceId: "ws_00000000-0000-7000-8000-000000000101" }]),
    };
    const guard = new ActorContextGuard(
      identityService as unknown as IdentityService,
      db as unknown as PlatformDb,
    );
    const { context, request } = contextWithCookie("alter_access=token-value");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actorContext).toMatchObject({
      user_id: session.userId,
      tenant_id: session.tenantId,
      workspace_id: "ws_00000000-0000-7000-8000-000000000101",
      roles: ["member", "editor"],
      session_id: session.id,
    });
    // ENGINE-FIX-P3-7: permissions is derived from roles, not hardcoded [].
    expect(request.actorContext?.permissions).toEqual(
      expect.arrayContaining(["credential:read", "projects:write"]),
    );
  });

  it("omits workspace_id when no workspace role row is returned", async () => {
    const identityService = {
      authenticateAccessToken: vi.fn().mockResolvedValue(session),
    };
    const db = {
      queryTenant: vi
        .fn()
        .mockResolvedValueOnce([{ role: "owner", workspaceId: null }])
        .mockResolvedValueOnce([]),
    };
    const guard = new ActorContextGuard(
      identityService as unknown as IdentityService,
      db as unknown as PlatformDb,
    );
    const { context, request } = contextWithCookie("alter_access=token-value");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actorContext).not.toHaveProperty("workspace_id");
    expect(request.actorContext?.roles).toEqual(["owner"]);
  });

  it("swallows an invalid/expired session, logs, and still returns true with no actorContext", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const identityService = {
      authenticateAccessToken: vi.fn().mockRejectedValue(new Error("Access token rejected")),
    };
    const db = { queryTenant: vi.fn() };
    const guard = new ActorContextGuard(
      identityService as unknown as IdentityService,
      db as unknown as PlatformDb,
    );
    const { context, request } = contextWithCookie("alter_access=stale-token");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actorContext).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("ActorContextGuard failed:", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("orders the workspace_members query deterministically so the chosen workspace_id is stable", async () => {
    const identityService = {
      authenticateAccessToken: vi.fn().mockResolvedValue(session),
    };
    const queryTenant = vi
      .fn()
      .mockResolvedValueOnce([{ role: "member", workspaceId: null }])
      .mockResolvedValueOnce([
        { role: "editor", workspaceId: "ws_00000000-0000-7000-8000-000000000101" },
        { role: "viewer", workspaceId: "ws_00000000-0000-7000-8000-000000000102" },
      ]);
    const db = { queryTenant };
    const guard = new ActorContextGuard(
      identityService as unknown as IdentityService,
      db as unknown as PlatformDb,
    );
    const { context, request } = contextWithCookie("alter_access=token-value");

    await guard.canActivate(context);
    // workspace_members is the second queryTenant call; the flat workspace_id
    // is taken from its first row, so the ordering must be deterministic.
    const workspaceQuery = queryTenant.mock.calls[1]?.[1] as string;
    expect(workspaceQuery).toContain("ORDER BY m.created_at ASC, m.workspace_id ASC");
    // D2: roles in a workspace pending deletion are not granted.
    expect(workspaceQuery).toContain("w.status <> 'pending_deletion'");
    // Earliest-created workspace wins regardless of physical row order.
    expect(request.actorContext?.workspace_id).toBe(
      "ws_00000000-0000-7000-8000-000000000101",
    );
  });
});
