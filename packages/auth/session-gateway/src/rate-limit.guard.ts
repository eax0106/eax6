import { randomUUID } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from "@nestjs/common";
import type { ProblemDetails } from "@alterx/contracts";
import { PUBLIC_ROUTE_METADATA } from "./public-route";
import type { IdentityTenantGatewayRequest, IdentityTenantGatewayResponse } from "./types";

export interface RateLimitBucket {
  windowStartedAtMs: number;
  count: number;
}

export interface SessionGatewayRateLimitOptions {
  readonly limitPerMinute?: number;
  readonly maxTrackedTenants?: number;
  readonly now?: () => Date;
}

const DEFAULT_LIMIT_PER_MINUTE = 120;
const DEFAULT_MAX_TRACKED_TENANTS = 10_000;
const WINDOW_MS = 60 * 1000;

/**
 * Must be registered AFTER SessionGatewayGuard in the guard chain -- it reads
 * request.actorContext.tenant_id, which only SessionGatewayGuard populates.
 * A request that reaches this guard without an actorContext is treated as a
 * configuration error (fails closed), not silently allowed through.
 */
@Injectable()
export class SessionGatewayRateLimitGuard implements CanActivate {
  readonly #buckets = new Map<string, RateLimitBucket>();
  readonly #limitPerMinute: number;
  readonly #maxTrackedTenants: number;
  readonly #now: () => Date;

  constructor(options: SessionGatewayRateLimitOptions = {}) {
    this.#limitPerMinute = options.limitPerMinute ?? DEFAULT_LIMIT_PER_MINUTE;
    this.#maxTrackedTenants =
      options.maxTrackedTenants ?? DEFAULT_MAX_TRACKED_TENANTS;
    this.#now = options.now ?? (() => new Date());
  }

  canActivate(context: ExecutionContext): boolean {
    if (
      Reflect.getMetadata(PUBLIC_ROUTE_METADATA, context.getHandler()) ===
        true ||
      Reflect.getMetadata(PUBLIC_ROUTE_METADATA, context.getClass()) === true
    ) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdentityTenantGatewayRequest>();
    const tenantId = request.actorContext?.tenant_id;
    if (tenantId === undefined) {
      throw new HttpException(
        misconfigurationProblem(request.url),
        500,
      );
    }

    const nowMs = this.#now().getTime();
    const bucket = this.#buckets.get(tenantId);
    if (bucket === undefined || nowMs - bucket.windowStartedAtMs >= WINDOW_MS) {
      this.#sweepExpiredBuckets(nowMs);
      this.#evictIfAtCapacity();
      this.#buckets.set(tenantId, { windowStartedAtMs: nowMs, count: 1 });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > this.#limitPerMinute) {
      const response = http.getResponse<IdentityTenantGatewayResponse>();
      setProblemContentType(response);
      throw new HttpException(
        rateLimitProblem(
          request.url,
          `Rate limit of ${this.#limitPerMinute} requests per minute exceeded for this tenant.`,
        ),
        429,
      );
    }
    return true;
  }

  #sweepExpiredBuckets(nowMs: number): void {
    for (const [tenantId, bucket] of this.#buckets.entries()) {
      if (nowMs - bucket.windowStartedAtMs >= WINDOW_MS) {
        this.#buckets.delete(tenantId);
      }
    }
  }

  #evictIfAtCapacity(): void {
    if (this.#buckets.size < this.#maxTrackedTenants) {
      return;
    }
    let oldestTenantId: string | undefined;
    let oldestWindowStartedAtMs = Number.POSITIVE_INFINITY;
    for (const [tenantId, bucket] of this.#buckets.entries()) {
      if (bucket.windowStartedAtMs < oldestWindowStartedAtMs) {
        oldestTenantId = tenantId;
        oldestWindowStartedAtMs = bucket.windowStartedAtMs;
      }
    }
    if (oldestTenantId !== undefined) {
      this.#buckets.delete(oldestTenantId);
    }
  }
}

function setProblemContentType(response: IdentityTenantGatewayResponse): void {
  if (response.header) {
    response.header("content-type", "application/problem+json");
  } else {
    response.setHeader?.("content-type", "application/problem+json");
  }
}

function rateLimitProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  const instance = requestUrl?.startsWith("/") ? requestUrl : "/";
  return {
    type: "https://alter.dev/problems/session-gateway-rate-limit",
    title: "Too Many Requests",
    status: 429,
    detail,
    instance,
    error_code: "SESSION_GATEWAY_RATE_LIMIT_EXCEEDED",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: true,
    field_errors: [],
    documentation_key: "auth.rate-limit-exceeded",
  };
}

function misconfigurationProblem(requestUrl: string | undefined): ProblemDetails {
  const instance = requestUrl?.startsWith("/") ? requestUrl : "/";
  return {
    type: "https://alter.dev/problems/session-gateway-misconfigured",
    title: "Internal Server Error",
    status: 500,
    detail: "Rate limiting requires SessionGatewayGuard to run first.",
    instance,
    error_code: "SESSION_GATEWAY_MISCONFIGURED",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "auth.session-gateway-misconfigured",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}
