import { createHash, timingSafeEqual } from "node:crypto";
import {v7 as uuidv7} from "uuid";
import { Body, Controller, Get, Headers, HttpException, Inject, Post, Query } from "@nestjs/common";
import { Public as BypassIdentityTenantActorAuth } from "@alterx/auth";
import {
  DeploymentAdminInternalActionRequestSchema,
  TenantDeploymentListRequestSchema,
  ProblemDetailsSchema,
  type ProblemDetails,
} from "@alterx/contracts";
import {
  DeploymentAdminConflictError,
  DeploymentAdminNotFoundError,
  DeploymentAdminService,
  DeploymentAdminPreconditionError,
} from "./deployment-admin.service";

export const DEPLOYMENT_ADMIN_TOKEN_HASH = Symbol("DEPLOYMENT_ADMIN_TOKEN_HASH");

@BypassIdentityTenantActorAuth()
@Controller("internal/admin/deployments")
export class DeploymentAdminController {
  constructor(
    private readonly service: DeploymentAdminService,
    @Inject(DEPLOYMENT_ADMIN_TOKEN_HASH) private readonly tokenHash: string,
  ) {}

  @Get()
  list(@Query() query: unknown, @Headers("authorization") authorization?: string) {
    this.authorize(authorization);
    const parsed = TenantDeploymentListRequestSchema.safeParse(query);
    if (!parsed.success) throw failure(400, "DEPLOYMENT_ADMIN_VALIDATION_FAILED");
    return this.service.list(parsed.data.tenant_id);
  }

  @Post("actions/apply")
  async apply(@Body() body: unknown, @Headers("authorization") authorization?: string, @Headers("if-match") ifMatch?:string) {
    this.authorize(authorization);
    const parsed = DeploymentAdminInternalActionRequestSchema.safeParse(body);
    if (!parsed.success) throw failure(400, "DEPLOYMENT_ADMIN_VALIDATION_FAILED");
    try {
      const {staff_user_id,...input}=parsed.data;
      return await this.service.apply(input,staff_user_id,ifMatch);
    } catch (error: unknown) {
      if (error instanceof DeploymentAdminPreconditionError) throw failure(error.status,error.status===428?"PRECONDITION_REQUIRED":"PRECONDITION_FAILED",error.message);
      if (error instanceof DeploymentAdminNotFoundError) {
        throw failure(404, "DEPLOYMENT_ADMIN_NOT_FOUND", error.message);
      }
      if (error instanceof DeploymentAdminConflictError) {
        throw failure(409, "DEPLOYMENT_ADMIN_CONFLICT", error.message);
      }
      throw error;
    }
  }

  private authorize(authorization: string | undefined): void {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw failure(401, "DEPLOYMENT_ADMIN_AUTHENTICATION_FAILED");
    }
  }
}

function failure(status: number, code: string, detail = code): HttpException {
  const problem: ProblemDetails = ProblemDetailsSchema.parse({
    type: `https://alter.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Bad Request",
    status,
    detail,
    instance: "/internal/admin/deployments/actions/apply",
    error_code: code,
    trace_id: generatedId("trc"),
    request_id: generatedId("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "deployment.admin",
  });
  return new HttpException(problem, status);
}

function generatedId(prefix: "trc" | "req"): string {
  return `${prefix}_${uuidv7()}`;
}
