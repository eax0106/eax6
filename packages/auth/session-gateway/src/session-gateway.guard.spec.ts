import { HttpException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ActorTokenValidator } from "./actor-token-validator";
import type { M2mValidator } from "./m2m-validator";
import { PUBLIC_ROUTE_METADATA } from "./public-route";
import { SessionGatewayGuard } from "./session-gateway.guard";
import {
  SessionGatewayAuthError,
  type ActorContext,
  type SessionGatewayRequest,
  type TenantDatabaseScope,
} from "./types";

const userActor: ActorContext = {
  actor_type: "user",
  user_id: "usr_00000000-0000-7000-8000-000000000003",
  tenant_id: "ten_00000000-0000-7000-8000-000000000001",
  workspace_id: "ws_00000000-0000-7000-8000-000000000002",
  roles: ["member"],
  permissions: ["workflow:read"],
  session_id: "session-test",
  jti: "jti-test",
};

const serviceActor: ActorContext = {
  ...userActor,
  actor_type: "service",
  user_id: null,
  session_id: null,
  jti: null,
};

const systemActor: ActorContext = {
  actor_type: "system",
  user_id: null,
  tenant_id: "ten_00000000-0000-7000-8000-000000000001",
  workspace_id: null,
  roles: ["system:platform-jobs"],
  permissions: ["runs:read"],
  session_id: null,
  jti: "jti-system",
};

function setup(options: {
  actor?: ActorContext;
  method?: string;
  serviceActor?: ActorContext | null;
  m2mError?: unknown;
  actorError?: unknown;
  publicRoute?: boolean;
} = {}) {
  const m2mValidator = {
    validate: options.m2mError
      ? vi.fn().mockRejectedValue(options.m2mError)
      : vi.fn().mockResolvedValue({
          claims: {},
          serviceActor: options.serviceActor ?? null,
        }),
  };
  const actorTokenValidator = {
    validate: options.actorError
      ? vi.fn().mockRejectedValue(options.actorError)
      : vi.fn().mockResolvedValue({
          claims: { exp: 1_800_000_300 },
          actorContext: options.actor ?? userActor,
        }),
  };
  const databaseScope: TenantDatabaseScope = {
    withTenant: vi.fn(async (_tenantId, operation) =>
      operation({
        query: async () => ({ rows: [{ visible: true }], rowCount: 1 }),
      }),
    ),
  };
  const request: SessionGatewayRequest = {
    headers: {
      authorization: "Bearer machine",
      "x-alter-actor-token": "actor",
    },
    url: "/v1/workflows",
    ...(options.method === undefined ? {} : { method: options.method }),
  };
  const response = { header: vi.fn() };
  const handler = () => undefined;
  if (options.publicRoute) {
    Reflect.defineMetadata(PUBLIC_ROUTE_METADATA, true, handler);
  }
  const executionContext = {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  const guard = new SessionGatewayGuard(
    m2mValidator as unknown as M2mValidator,
    actorTokenValidator as unknown as ActorTokenValidator,
    databaseScope,
  );
  return {
    actorTokenValidator,
    databaseScope,
    executionContext,
    guard,
    m2mValidator,
    request,
    response,
  };
}

describe("SessionGatewayGuard", () => {
  it("bypasses authentication only for explicitly public routes", async () => {
    const { actorTokenValidator, executionContext, guard, m2mValidator } =
      setup({
        publicRoute: true,
        m2mError: new SessionGatewayAuthError("AUTH_INVALID_M2M_TOKEN"),
      });

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(m2mValidator.validate).not.toHaveBeenCalled();
    expect(actorTokenValidator.validate).not.toHaveBeenCalled();
  });

  it("does not bypass authentication for protected routes", async () => {
    const { executionContext, guard } = setup({
      m2mError: new SessionGatewayAuthError("AUTH_INVALID_M2M_TOKEN"),
    });

    await expectProblem(
      guard.canActivate(executionContext),
      "AUTH_INVALID_M2M_TOKEN",
    );
  });

  it("attaches trusted user context and a tenant-bound database callback", async () => {
    const { databaseScope, executionContext, guard, request } = setup();
    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request.actorContext).toEqual(userActor);
    expect(request.actorTokenExpiresAtMs).toBe(1_800_000_300_000);

    const result = await request.withTenantDatabase?.((transaction) =>
      transaction.query("SELECT * FROM workflows"),
    );
    expect(result?.rows).toEqual([{ visible: true }]);
    expect(databaseScope.withTenant).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000001",
      expect.any(Function),
    );
  });

  describe("system principal (D1)", () => {
    it.each(["GET", "HEAD"])("lets a system principal %s", async (method) => {
      const { executionContext, guard, request } = setup({ actor: systemActor, method });
      await expect(guard.canActivate(executionContext)).resolves.toBe(true);
      expect(request.actorContext).toEqual(systemActor);
    });

    it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
      "refuses a system principal %s with 403 and attaches nothing",
      async (method) => {
        const { executionContext, guard, request } = setup({ actor: systemActor, method });
        const error = await captured(guard.canActivate(executionContext));
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(403);
        expect((error as HttpException).getResponse()).toMatchObject({
          error_code: "AUTH_SYSTEM_PRINCIPAL_READ_ONLY",
          status: 403,
        });
        expect(request.actorContext).toBeUndefined();
      },
    );

    it("refuses a system principal when the method is unknown (fails closed)", async () => {
      const { executionContext, guard } = setup({ actor: systemActor });
      await expectProblem(guard.canActivate(executionContext), "AUTH_SYSTEM_PRINCIPAL_READ_ONLY");
    });

    it("does not restrict a user principal by method", async () => {
      const { executionContext, guard } = setup({ method: "POST" });
      await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    });
  });

  it("uses service context and skips actor-token validation", async () => {
    const { actorTokenValidator, executionContext, guard, request } = setup({
      serviceActor,
    });
    delete (request.headers as Record<string, unknown>)["x-alter-actor-token"];
    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request.actorContext).toEqual(serviceActor);
    expect(actorTokenValidator.validate).not.toHaveBeenCalled();
  });

  it("validates gRPC metadata without treating the protobuf message as an HTTP request", async () => {
    const { guard, m2mValidator } = setup();
    const executionContext = rpcContext(["Bearer machine"]);

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(m2mValidator.validate).toHaveBeenCalledWith("Bearer machine");
  });

  it("rejects gRPC calls without a machine credential", async () => {
    const { guard } = setup({
      m2mError: new SessionGatewayAuthError("AUTH_INVALID_M2M_TOKEN"),
    });

    await expectProblem(guard.canActivate(rpcContext(undefined)), "AUTH_INVALID_M2M_TOKEN");
  });

  it("accepts array headers and preserves an unprefixed database tenant", async () => {
    const { databaseScope, executionContext, guard, request } = setup({
      serviceActor: {
        ...serviceActor,
        tenant_id: "00000000-0000-7000-8000-000000000001",
      },
    });
    (request.headers as Record<string, unknown>).authorization = [
      "Bearer machine",
    ];
    await guard.canActivate(executionContext);
    await request.withTenantDatabase?.(async () => "done");
    expect(databaseScope.withTenant).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000001",
      expect.any(Function),
    );
  });

  it("rejects a missing actor token for people-originated traffic", async () => {
    const { executionContext, guard, request } = setup();
    delete (request.headers as Record<string, unknown>)["x-alter-actor-token"];
    await expectProblem(
      guard.canActivate(executionContext),
      "AUTH_MISSING_ACTOR_TOKEN",
    );
  });

  it.each([
    "AUTH_INVALID_M2M_TOKEN",
    "AUTH_INVALID_ACTOR_TOKEN",
    "AUTH_ACTOR_TOKEN_LIFETIME_EXCEEDED",
    "AUTH_ACTOR_TOKEN_EXPIRED",
    "AUTH_ACTOR_TOKEN_REPLAY",
  ] as const)("returns non-leaking RFC 9457 shape for %s", async (errorCode) => {
    const options =
      errorCode === "AUTH_INVALID_M2M_TOKEN"
        ? { m2mError: new SessionGatewayAuthError(errorCode) }
        : { actorError: new SessionGatewayAuthError(errorCode) };
    const { executionContext, guard, response } = setup(options);
    const error = await captured(guard.canActivate(executionContext));
    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse();
    expect(body).toMatchObject({
      type: expect.stringMatching(/^https:\/\/alter\.dev\/problems\//),
      title: "Unauthorized",
      status: 401,
      error_code: errorCode,
      retryable: false,
      field_errors: [],
    });
    expect(response.header).toHaveBeenCalledWith(
      "content-type",
      "application/problem+json",
    );
    expect(JSON.stringify(body)).not.toMatch(
      /tenant_id|stack|select\s|insert\s|update\s|delete\s|auth0|redis|postgres/i,
    );
  });

  it("sanitizes unexpected failures and supports Node response headers", async () => {
    const { executionContext, guard, request } = setup({
      actorError: new Error("SELECT tenant_id FROM secrets in postgres"),
    });
    (request as { url?: string }).url = "not-a-path";
    const setHeader = vi.fn();
    vi.spyOn(executionContext, "switchToHttp").mockReturnValue({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    } as ReturnType<ExecutionContext["switchToHttp"]>);

    const error = await captured(guard.canActivate(executionContext));
    expect((error as HttpException).getResponse()).toMatchObject({
      error_code: "AUTH_INVALID_ACTOR_TOKEN",
      instance: "/",
    });
    expect(setHeader).toHaveBeenCalledWith(
      "content-type",
      "application/problem+json",
    );
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain(
      "SELECT",
    );
  });
});

async function expectProblem(
  promise: Promise<boolean>,
  errorCode: string,
): Promise<void> {
  const error = await captured(promise);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getResponse()).toMatchObject({
    error_code: errorCode,
  });
}

async function captured(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected guard rejection");
  } catch (error: unknown) {
    return error;
  }
}

function rpcContext(authorization: string[] | undefined): ExecutionContext {
  return {
    getType: () => "rpc",
    getHandler: () => () => undefined,
    getClass: () => class TestController {},
    switchToRpc: () => ({
      getContext: () => ({
        get: (key: string) => (key === "authorization" ? authorization : undefined),
      }),
    }),
  } as unknown as ExecutionContext;
}
