import { randomUUID } from "node:crypto";
import { Controller, Get, HttpException, Query, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import {
  RunObservabilityService,
  RunObservabilityValidationError,
} from "./run-observability.service";

interface FeedQuery {
  readonly resolved_after?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

/**
 * Recoveries that worked, across a tenant's workspaces (D1). It exists for the
 * platform's background jobs, which tell people what Alter fixed, so it answers
 * the system principal only: a workspace member reading it would see other
 * workspaces' runs.
 */
@Controller("api/v1/recovery-actions")
export class RecoveryFeedController {
  constructor(private readonly observability: RunObservabilityService) {}

  @Get()
  async list(@Req() request: SessionGatewayRequest, @Query() query: FeedQuery) {
    const actor = request.actorContext;
    if (actor === undefined) {
      throw new HttpException(problem(request.url, 500, "RECOVERY_FEED_INTERNAL", "Missing authenticated tenant context"), 500);
    }
    if (actor.actor_type !== "system") {
      throw new HttpException(
        problem(request.url, 403, "RECOVERY_FEED_SYSTEM_ONLY", "This feed is for the platform's background jobs"),
        403,
      );
    }
    try {
      return await this.observability.recentResolvedRecoveries(actor.tenant_id, {
        ...(query.resolved_after === undefined ? {} : { resolvedAfter: query.resolved_after }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
    } catch (error: unknown) {
      if (error instanceof RunObservabilityValidationError) {
        throw new HttpException(problem(request.url, 400, "RECOVERY_FEED_VALIDATION_FAILED", error.message), 400);
      }
      throw new HttpException(problem(request.url, 500, "RECOVERY_FEED_INTERNAL", "Recoveries could not be listed"), 500);
    }
  }
}

function problem(
  instance: string | undefined,
  status: 400 | 403 | 500,
  errorCode: string,
  detail: string,
): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Internal Server Error",
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "runs.recovery-feed",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
