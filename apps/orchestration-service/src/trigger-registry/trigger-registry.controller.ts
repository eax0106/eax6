import { workspaceReadScope } from "../workspace-read-scope";
import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import { InvalidCronExpressionError } from "./cron-validator";
import { InvalidDlqPolicyError } from "./dlq-policy";
import {
  TriggerNotFoundError,
  TriggerRegistryService,
  TriggerStateTransitionError,
  TriggerValidationError,
  type RegisterTriggerRequest,
  type TriggerStatus,
  type TriggerType,
} from "./trigger-registry.service";

interface RegisterTriggerBody {
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly type: TriggerType;
  readonly provider?: string;
  readonly workflowVersionId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

interface CreateTriggerVersionBody {
  readonly workflowVersionId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

interface SetTriggerStatusBody {
  readonly status: TriggerStatus;
}

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(
      internalProblem(request.url, "Missing authenticated tenant context"),
      500,
    );
  }
  return tenantId;
}

@Controller("api/v1/triggers")
export class TriggerRegistryController {
  constructor(private readonly service: TriggerRegistryService) {}

  @Post()
  async register(
    @Req() request: IdentityTenantGatewayRequest,
    @Body() body: RegisterTriggerBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      const registerRequest: RegisterTriggerRequest = {
        tenantId,
        workspaceId: body.workspaceId,
        workflowId: body.workflowId,
        name: body.name,
        type: body.type,
        ...(body.provider === undefined ? {} : { provider: body.provider }),
        ...(body.workflowVersionId === undefined
          ? {}
          : { workflowVersionId: body.workflowVersionId }),
        ...(body.config === undefined ? {} : { config: body.config }),
      };
      return await this.service.registerTrigger(registerRequest);
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Post(":id/versions")
  async createVersion(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") triggerId: string,
    @Body() body: CreateTriggerVersionBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.createTriggerVersion({
        tenantId,
        triggerId,
        ...(body.workflowVersionId === undefined
          ? {}
          : { workflowVersionId: body.workflowVersionId }),
        ...(body.config === undefined ? {} : { config: body.config }),
      });
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Patch(":id/status")
  async setStatus(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") triggerId: string,
    @Body() body: SetTriggerStatusBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.setTriggerStatus(
        tenantId,
        triggerId,
        body.status,
      );
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Post(":id/actions/enable")
  async enable(@Req() request: IdentityTenantGatewayRequest, @Param("id") triggerId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.setTriggerStatus(tenantId, triggerId, "enabled");
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Post(":id/actions/test")
  async test(@Req() request: IdentityTenantGatewayRequest, @Param("id") triggerId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.testTrigger(tenantId, triggerId);
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Post(":id/actions/rotate-webhook-secret")
  async rotateWebhookSecret(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") triggerId: string,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.rotateWebhookSecret(tenantId, triggerId);
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: IdentityTenantGatewayRequest, @Param("id") triggerId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.getTrigger(tenantId, triggerId);
    } catch (error: unknown) {
      throw mapTriggerError(error, request.url);
    }
  }

  @Get()
  async list(
    @Req() request: IdentityTenantGatewayRequest,
    @Query("workflowId") workflowId?: string,
  ) {
    const tenantId = requiredTenantId(request);
    const triggers = await this.service.listTriggers(tenantId, workflowId, workspaceReadScope(request).workspaceId);
    return { triggers };
  }
}

function mapTriggerError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof TriggerNotFoundError) {
    return new HttpException(notFoundProblem(requestUrl, error.message), 404);
  }
  if (error instanceof TriggerStateTransitionError) {
    return new HttpException(conflictProblem(requestUrl, error.message), 409);
  }
  if (
    error instanceof TriggerValidationError ||
    error instanceof InvalidCronExpressionError ||
    error instanceof InvalidDlqPolicyError
  ) {
    return new HttpException(badRequestProblem(requestUrl, error.message), 400);
  }
  if (error instanceof HttpException) {
    return error;
  }
  return new HttpException(
    internalProblem(requestUrl, "Trigger registry request could not be completed"),
    500,
  );
}

function instanceOrRoot(requestUrl: string | undefined): string {
  return requestUrl?.startsWith("/") ? requestUrl : "/";
}

function badRequestProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/trigger-registry-validation",
    title: "Bad Request",
    status: 400,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "TRIGGER_REGISTRY_VALIDATION_FAILED",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "triggers.validation-failed",
  };
}

function notFoundProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/trigger-registry-not-found",
    title: "Not Found",
    status: 404,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "TRIGGER_NOT_FOUND",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "triggers.not-found",
  };
}

function conflictProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/trigger-registry-conflict",
    title: "Conflict",
    status: 409,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "TRIGGER_STATE_TRANSITION_INVALID",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "triggers.invalid-state-transition",
  };
}

function internalProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/trigger-registry-internal",
    title: "Internal Server Error",
    status: 500,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "TRIGGER_REGISTRY_INTERNAL_ERROR",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "triggers.internal-error",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
