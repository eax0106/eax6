import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Headers,
  HttpException,
  Inject,
  Post,
  Query,
  UseFilters,
} from "@nestjs/common";
import { Public as BypassSessionGatewayActorAuth } from "@alterx/auth";
import { ProblemDetailsSchema, type ProblemDetails } from "@alterx/contracts";
import { OrchestrationDeletionService } from "./deletion.service";

interface DeleteBody { readonly tenantId: string; readonly manifestId: string }
interface WorkspaceBody { readonly tenantId: string; readonly workspaceId: string; readonly manifestId?: string }
export const ORCHESTRATION_DELETION_TOKEN_HASH = Symbol("ORCHESTRATION_DELETION_TOKEN_HASH");

@Catch(HttpException)
class DeletionProblemFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { header(name: string, value: string): { send(body: unknown): void } };
    }>();
    response.status(error.getStatus()).header("content-type", "application/problem+json").send(error.getResponse());
  }
}

// Cross-tenant replay cannot carry one actor tenant context. This bypasses only
// SessionGateway's actor guard; every method still requires the dedicated,
// constant-time-checked service credential and lives under /internal only.
@BypassSessionGatewayActorAuth()
@UseFilters(DeletionProblemFilter)
@Controller("internal/deletion")
export class DeletionController {
  constructor(
    private readonly service: OrchestrationDeletionService,
    @Inject(ORCHESTRATION_DELETION_TOKEN_HASH)
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

  private async handle<T>(instance: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      const message = error instanceof Error ? error.message : "";
      const status = message.includes("tenantId") || message.includes("workspaceId") || message.includes("manifestId") ? 400 : 500;
      throw new HttpException(problem(instance, status), status);
    }
  }

  @Get("locate")
  locate(@Query("tenantId") tenantId: string, @Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/locate", () => this.service.locateSubjectData(tenantId));
  }
  @Post("delete")
  delete(@Body() body: DeleteBody, @Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/delete", () => this.service.deleteSubjectData(body.tenantId, body.manifestId));
  }
  @Post("verify")
  verify(@Body() body: DeleteBody, @Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/verify", () => this.service.verifyDeletion(body.tenantId, body.manifestId));
  }
  // D2: one workspace's erasure at the end of its undo window.
  @Post("workspace/locate")
  locateWorkspace(@Body() body: WorkspaceBody, @Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/workspace/locate", () => this.service.locateWorkspaceData(body.tenantId, body.workspaceId));
  }
  @Post("workspace/delete")
  deleteWorkspace(@Body() body: WorkspaceBody, @Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/workspace/delete", () => this.service.deleteWorkspaceData(body.tenantId, body.workspaceId, body.manifestId ?? ""));
  }
  @Post("workspace/verify")
  verifyWorkspace(@Body() body: WorkspaceBody, @Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/workspace/verify", () => this.service.verifyWorkspaceDeletion(body.tenantId, body.workspaceId, body.manifestId ?? ""));
  }
  @Post("retention")
  retention(@Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/retention", () => this.service.applyRetentionPolicy());
  }
  @Get("subjects")
  subjects(@Headers("authorization") auth?: string) {
    this.authorize(auth); return this.handle("/internal/deletion/subjects", () => this.service.listSubjectIds());
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
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `${prefix}_${id}`;
}
