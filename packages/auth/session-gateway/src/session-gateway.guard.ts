import { randomUUID } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from "@nestjs/common";
import type { ProblemDetails } from "@alterx/contracts";
import type { ActorTokenValidator } from "./actor-token-validator";
import { SESSION_GATEWAY_FEATURE_DECISION } from "./feature-decision";
import type { M2mValidator } from "./m2m-validator";
import { PUBLIC_ROUTE_METADATA } from "./public-route";
import {
  SessionGatewayAuthError,
  type SessionGatewayErrorCode,
  type IdentityTenantGatewayRequest,
  type IdentityTenantGatewayResponse,
  type TenantDatabaseScope,
} from "./types";

const SAFE_DETAILS: Record<SessionGatewayErrorCode, string> = {
  AUTH_INVALID_M2M_TOKEN: "The machine credential is missing or invalid.",
  AUTH_MISSING_ACTOR_TOKEN: "A delegation token is required for this request.",
  AUTH_INVALID_ACTOR_TOKEN: "The delegation token is invalid.",
  AUTH_ACTOR_TOKEN_LIFETIME_EXCEEDED:
    "The delegation token lifetime exceeds the allowed maximum.",
  AUTH_ACTOR_TOKEN_EXPIRED: "The delegation token has expired.",
  AUTH_ACTOR_TOKEN_REPLAY: "The delegation token has already been used.",
  AUTH_SYSTEM_PRINCIPAL_READ_ONLY:
    "This credential may only read.",
};

/** A system principal (D1) reads; it never changes anything. */
const SYSTEM_PRINCIPAL_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

@Injectable()
export class SessionGatewayGuard implements CanActivate {
  readonly featureDecision = SESSION_GATEWAY_FEATURE_DECISION;

  constructor(
    private readonly m2mValidator: M2mValidator,
    private readonly actorTokenValidator: ActorTokenValidator,
    private readonly databaseScope: TenantDatabaseScope,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      Reflect.getMetadata(PUBLIC_ROUTE_METADATA, context.getHandler()) ===
        true ||
      Reflect.getMetadata(PUBLIC_ROUTE_METADATA, context.getClass()) === true
    ) {
      return true;
    }

    // An RPC context is NOT an HTTP one: switchToHttp().getRequest() returns the
    // decoded protobuf message, which has no `.headers`, so the HTTP path below
    // throws a TypeError on every gRPC call and 401s the entire internal mesh.
    // Internal RPCs carry a machine credential in gRPC metadata and have no user
    // actor, so they take the M2M-only branch.
    // Nest always supplies getType(). The fallback keeps direct unit-context
    // doubles on the pre-existing HTTP path instead of throwing before auth.
    const contextType =
      typeof context.getType === "function" ? context.getType() : "http";
    if (contextType === "rpc") {
      return this.canActivateRpc(context);
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdentityTenantGatewayRequest>();
    const response = http.getResponse<IdentityTenantGatewayResponse>();

    try {
      const machine = await this.m2mValidator.validate(
        firstHeader(request.headers.authorization),
      );
      // A caller acting on behalf of a specific user always pairs the M2M
      // credential with a delegation token, so that real, correctly-scoped
      // actor identity must win whenever one is present -- the M2M token's
      // own tenant_id is only a coarse machine-credential claim (and, for
      // the local mock issuer, isn't even prefixed to the engine domain's
      // ten_/UUIDv7 shape). Falling back to machine.serviceActor only when
      // no actor token was sent at all preserves the genuine
      // service-to-service path (internal RPC, background jobs), which
      // never sends one.
      const actorTokenHeader = firstHeader(request.headers["x-alter-actor-token"]);
      const actorValidation = actorTokenHeader
        ? await this.actorTokenValidator.validate(actorTokenHeader)
        : undefined;
      const actor = actorValidation?.actorContext ?? machine.serviceActor;
      if (!actor) {
        throw new SessionGatewayAuthError("AUTH_MISSING_ACTOR_TOKEN");
      }

      if (
        actor.actor_type === "system" &&
        !SYSTEM_PRINCIPAL_METHODS.has((request.method ?? "").toUpperCase())
      ) {
        throw new SessionGatewayAuthError("AUTH_SYSTEM_PRINCIPAL_READ_ONLY");
      }

      request.actorContext = actor;
      if (actorValidation) {
        request.actorTokenExpiresAtMs = actorValidation.claims.exp * 1_000;
      }
      request.withTenantDatabase = <T>(
        operation: Parameters<TenantDatabaseScope["withTenant"]>[1],
      ) => this.databaseScope.withTenant(databaseTenantId(actor.tenant_id), operation) as Promise<T>;
      return true;
    } catch (error: unknown) {
      const authError =
        error instanceof SessionGatewayAuthError
          ? error
          : new SessionGatewayAuthError("AUTH_INVALID_ACTOR_TOKEN");
      setProblemContentType(response);
      throw new HttpException(
        problemBody(authError.errorCode, request.url),
        authError.errorCode === "AUTH_SYSTEM_PRINCIPAL_READ_ONLY" ? 403 : 401,
      );
    }
  }

  /**
   * Internal service-to-service RPC. Only the machine credential is validated:
   * there is no user actor and therefore no actor token, no replay key and no
   * tenant database scope to attach. Fails closed on anything unparseable.
   */
  private async canActivateRpc(context: ExecutionContext): Promise<boolean> {
    const metadata = context.switchToRpc().getContext<
      { get(key: string): unknown } | undefined
    >();
    const raw =
      metadata !== undefined && typeof metadata.get === "function"
        ? metadata.get("authorization")
        : undefined;
    const authorization = Array.isArray(raw)
      ? typeof raw[0] === "string"
        ? raw[0]
        : undefined
      : typeof raw === "string"
        ? raw
        : undefined;

    try {
      await this.m2mValidator.validate(authorization);
      return true;
    } catch {
      throw new HttpException(problemBody("AUTH_INVALID_M2M_TOKEN", "/"), 401);
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function databaseTenantId(tenantId: string): string {
  return tenantId.startsWith("ten_") ? tenantId.slice(4) : tenantId;
}

function setProblemContentType(response: IdentityTenantGatewayResponse): void {
  if (response.header) {
    response.header("content-type", "application/problem+json");
  } else {
    response.setHeader?.("content-type", "application/problem+json");
  }
}

function problemBody(
  errorCode: SessionGatewayErrorCode,
  requestUrl = "/",
): ProblemDetails {
  const key = errorCode.toLowerCase().replaceAll("_", "-");
  const forbidden = errorCode === "AUTH_SYSTEM_PRINCIPAL_READ_ONLY";
  return {
    type: `https://alter.dev/problems/${key}`,
    title: forbidden ? "Forbidden" : "Unauthorized",
    status: forbidden ? 403 : 401,
    detail: SAFE_DETAILS[errorCode],
    instance: requestUrl.startsWith("/") ? requestUrl : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: `auth.${key}`,
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}
