import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Headers,
  HttpException,
  Inject,
  Post,
  UseFilters,
} from "@nestjs/common";
import { ProblemDetailsSchema, TenantIdSchema, WorkspaceIdSchema, type ProblemDetails } from "@alterx/contracts";
import { createUuidV7 } from "../audit/audit-id";
import { DeletionOrchestrator } from "./deletion-orchestrator";

export const DELETION_SERVICE_TOKEN_HASH = Symbol("DELETION_SERVICE_TOKEN_HASH");

@Catch(HttpException)
class DeletionProblemFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { header(name: string, value: string): { send(body: unknown): void } };
    }>();
    response.status(error.getStatus()).header("content-type", "application/problem+json").send(error.getResponse());
  }
}

@UseFilters(DeletionProblemFilter)
@Controller("internal/deletion")
export class DeletionController {
  constructor(
    private readonly orchestrator: DeletionOrchestrator,
    @Inject(DELETION_SERVICE_TOKEN_HASH)
    private readonly tokenHash: string,
  ) {}

  private authorize(value: string | undefined): void {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException(problem("/internal/deletion", 401), 401);
    }
  }

  @Post("execute")
  async execute(@Body() body: { tenantId: string }, @Headers("authorization") auth?: string) {
    this.authorize(auth);
    try {
      return await this.orchestrator.execute(body.tenantId);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(problem("/internal/deletion/execute", 500), 500);
    }
  }
  // D2: erase one workspace at the end of its undo window.
  @Post("workspace/execute")
  async executeWorkspace(
    @Body() body: { tenantId?: unknown; workspaceId?: unknown },
    @Headers("authorization") auth?: string,
  ) {
    this.authorize(auth);
    const tenantId = TenantIdSchema.safeParse(body?.tenantId);
    const workspaceId = WorkspaceIdSchema.safeParse(body?.workspaceId);
    if (!tenantId.success || !workspaceId.success) {
      throw new HttpException(problem("/internal/deletion/workspace/execute", 400), 400);
    }
    try {
      return await this.orchestrator.executeWorkspace(tenantId.data, workspaceId.data);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(problem("/internal/deletion/workspace/execute", 500), 500);
    }
  }
  @Post("replay")
  async replay(@Body() body: { sinceTimestamp: string }, @Headers("authorization") auth?: string) {
    this.authorize(auth);
    try {
      return await this.orchestrator.replayDeletionLedger(body.sinceTimestamp);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      const status = error instanceof Error && error.message.includes("sinceTimestamp") ? 400 : 500;
      throw new HttpException(problem("/internal/deletion/replay", status), status);
    }
  }
}

function problem(instance: string, status: 400 | 401 | 500): ProblemDetails {
  const errorCode = status === 401 ? "DELETION_AUTHENTICATION_FAILED"
    : status === 400 ? "DELETION_VALIDATION_FAILED" : "DELETION_INTERNAL_ERROR";
  return ProblemDetailsSchema.parse({
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 401 ? "Unauthorized" : status === 400 ? "Bad Request" : "Internal Server Error",
    status,
    detail: status === 401 ? "Internal service authentication failed"
      : status === 400 ? "Deletion request validation failed" : "Deletion request could not be completed",
    instance,
    error_code: errorCode,
    trace_id: generatedId("trc"),
    request_id: generatedId("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "deletion.internal",
  });
}

function generatedId(prefix: "trc" | "req"): string {
  return `${prefix}_${createUuidV7()}`;
}
