import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Query,
  UseFilters,
} from "@nestjs/common";
import {
  ProblemDetailsSchema,
  type ProblemDetails,
  type RecordEventRequest,
} from "@alterx/contracts";
import { createUuidV7 } from "./audit-id";
import { Public } from "@alterx/auth";
import { AuditValidationError } from "@alterx/shared-clients";
import { AuditService } from "./audit.service";

export const AUDIT_QUERY_SERVICE_TOKEN_HASH = Symbol("AUDIT_QUERY_SERVICE_TOKEN_HASH");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Catch(HttpException)
class AuditQueryProblemFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { header(name: string, value: string): { send(body: unknown): void } };
    }>();
    response.status(error.getStatus()).header("content-type", "application/problem+json").send(error.getResponse());
  }
}

const DEFAULT_VERIFY_CHAIN_LIMIT = 500;
const MAX_VERIFY_CHAIN_LIMIT = 5_000;

interface RawQuery {
  readonly tenant_id?: string;
  readonly actor_types?: string;
  readonly action?: string;
  readonly result?: string;
  readonly occurred_after?: string;
  readonly occurred_before?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

// Internal-only, service-token authenticated (same trust boundary and
// pattern as DeletionController). No actor_type/tenant visibility policy
// is enforced here -- that's platform-api's job (it has the RBAC/staff-role
// concepts this service deliberately doesn't). tenant_id omitted or empty
// performs a genuinely cross-tenant query; only a trusted internal caller
// (platform-api) should ever be able to reach this route.
//
// ENGINE-FIX-PHASE2-N2: @Public() opts this controller out of the app-wide
// ServiceAuthGuard (Auth0 M2M JWT), which otherwise reads the same
// Authorization header this controller's own authorize() checks and
// rejects it first -- every real caller here (background-workers'
// audit-chain-verify sweep, platform-api's AuditEventsClient) sends the
// raw shared secret, never a JWT, so the route 401'd before its own,
// correct, timing-safe check ever ran. Same pattern already established
// for HMAC-authenticated routes (see integration-webhook.controller.ts).
@Public()
@UseFilters(AuditQueryProblemFilter)
@Controller("internal/audit-events")
export class AuditQueryController {
  constructor(
    private readonly audit: AuditService,
    @Inject(AUDIT_QUERY_SERVICE_TOKEN_HASH)
    private readonly tokenHash: string,
  ) {}

  private authorize(value: string | undefined): void {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException(problem("/internal/audit-events", 401), 401);
    }
  }

  @Get()
  async query(@Query() query: RawQuery, @Headers("authorization") auth?: string) {
    this.authorize(auth);
    const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new HttpException(problem("/internal/audit-events", 400, "limit must be a positive integer"), 400);
    }
    try {
      return await this.audit.queryEvents({
        tenantId: query.tenant_id ?? "",
        actorTypes: query.actor_types === undefined ? [] : query.actor_types.split(","),
        action: query.action ?? "",
        result: query.result ?? "",
        occurredAfter: query.occurred_after ?? "",
        occurredBefore: query.occurred_before ?? "",
        cursor: query.cursor ?? "",
        limit: Math.min(limit, MAX_LIMIT),
      });
    } catch (error: unknown) {
      if (error instanceof AuditValidationError) {
        throw new HttpException(problem("/internal/audit-events", 400, error.message), 400);
      }
      throw new HttpException(problem("/internal/audit-events", 500), 500);
    }
  }

  // ENGINE-FIX-P3-13: the scheduled path for background-workers'
  // audit-chain-verify sweep. Returns the verification result directly
  // (200, valid: true or false) rather than throwing on an invalid chain --
  // a broken chain is a real finding to report and alert on, not a failed
  // request. The bound is a request-size safety net; the checkpoint itself
  // is what keeps a real periodic schedule at O(new entries).
  @Post("verify-chain")
  @HttpCode(200)
  async verifyChain(
    @Query() query: { readonly limit?: string },
    @Headers("authorization") auth?: string,
  ) {
    this.authorize(auth);
    const limit = query.limit === undefined ? DEFAULT_VERIFY_CHAIN_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new HttpException(
        problem("/internal/audit-events/verify-chain", 400, "limit must be a positive integer"),
        400,
      );
    }
    try {
      return await this.audit.verifyChainIncremental(Math.min(limit, MAX_VERIFY_CHAIN_LIMIT));
    } catch {
      throw new HttpException(problem("/internal/audit-events/verify-chain", 500), 500);
    }
  }

  // Weekly defense in depth for the incremental verifier above. A checkpoint
  // makes the frequent path cheap, but it also puts already-checkpointed
  // history outside that path's view. This endpoint deliberately walks from
  // genesis so later tampering with old rows cannot remain permanently hidden.
  @Post("verify-chain/full")
  @HttpCode(200)
  async verifyFullChain(@Headers("authorization") auth?: string) {
    this.authorize(auth);
    try {
      return await this.audit.verifyChain();
    } catch {
      throw new HttpException(problem("/internal/audit-events/verify-chain/full", 500), 500);
    }
  }

  @Post()
  @HttpCode(201)
  async record(
    @Body() body: RecordEventRequest,
    @Headers("authorization") auth?: string,
  ) {
    this.authorize(auth);
    try {
      return await this.audit.recordEvent(body);
    } catch (error: unknown) {
      if (error instanceof AuditValidationError) {
        throw new HttpException(
          problem("/internal/audit-events", 400, error.message),
          400,
        );
      }
      throw new HttpException(problem("/internal/audit-events", 500), 500);
    }
  }
}

function problem(instance: string, status: 400 | 401 | 500, detail?: string): ProblemDetails {
  const errorCode = status === 401 ? "AUDIT_QUERY_AUTHENTICATION_FAILED"
    : status === 400 ? "AUDIT_QUERY_VALIDATION_FAILED" : "AUDIT_QUERY_INTERNAL_ERROR";
  return ProblemDetailsSchema.parse({
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 401 ? "Unauthorized" : status === 400 ? "Bad Request" : "Internal Server Error",
    status,
    detail: detail ?? (status === 401 ? "Internal service authentication failed"
      : status === 400 ? "Audit event query validation failed" : "Audit event query could not be completed"),
    instance,
    error_code: errorCode,
    trace_id: generatedId("trc"),
    request_id: generatedId("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "audit-events.internal",
  });
}

function generatedId(prefix: "trc" | "req"): string {
  return `${prefix}_${createUuidV7()}`;
}
