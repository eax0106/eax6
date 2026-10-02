import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type {
  RotateWebhookSecretResult,
  TriggerBinding,
  WebhookEndpoint,
} from "@alterx/contracts";
import { mapBindingError } from "./problem";
import { TriggerBindingService } from "./trigger-binding.service";
import { parseCreateBindingBody } from "./validation";

/**
 * ENG-BINDING management surface. Tenant and workspace both come from the
 * authenticated actor context -- never from the request body -- so a binding
 * can only ever be created inside the caller's own workspace.
 *
 * No route on this controller returns secret material. The rotate route
 * returns version and timing metadata only; the new signing secret is
 * readable solely through SecretsProvider.
 */
@Controller("v1/triggers")
export class TriggerBindingController {
  constructor(private readonly service: TriggerBindingService) {}

  @Post(":id/bindings")
  @HttpCode(201)
  async bind(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") triggerId: string,
    @Body() body: unknown,
  ): Promise<TriggerBinding> {
    try {
      const parsed = parseCreateBindingBody(body);
      return await this.service.bindTrigger({
        tenantId: requiredTenantId(request),
        workspaceId: requiredWorkspaceId(request),
        triggerId,
        integrationId: parsed.integrationId,
        config: parsed.config,
      });
    } catch (error: unknown) {
      throw mapBindingError(error, request.url);
    }
  }

  @Get(":id/bindings")
  async list(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") triggerId: string,
  ): Promise<{ readonly bindings: readonly TriggerBinding[] }> {
    try {
      return await this.service.listBindings(
        requiredTenantId(request),
        triggerId,
      );
    } catch (error: unknown) {
      throw mapBindingError(error, request.url);
    }
  }

  @Delete(":id/bindings/:bindingId")
  async disable(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") triggerId: string,
    @Param("bindingId") bindingId: string,
  ): Promise<TriggerBinding> {
    try {
      return await this.service.disableBinding(
        requiredTenantId(request),
        triggerId,
        bindingId,
      );
    } catch (error: unknown) {
      throw mapBindingError(error, request.url);
    }
  }
}

@Controller("v1")
export class WebhookEndpointController {
  constructor(private readonly service: TriggerBindingService) {}

  @Get("integrations/:integrationId/webhook-endpoint")
  async getEndpoint(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("integrationId") integrationId: string,
  ): Promise<WebhookEndpoint> {
    try {
      return await this.service.getEndpointForIntegration(
        requiredTenantId(request),
        requiredWorkspaceId(request),
        integrationId,
      );
    } catch (error: unknown) {
      throw mapBindingError(error, request.url);
    }
  }

  /**
   * Hard cutover: when this returns 200, the previous secret has already
   * stopped verifying. The response carries the policy it was executed under
   * so a caller can assert the semantics rather than assume them.
   */
  @Post("webhook-endpoints/:endpointId/actions/rotate-secret")
  @HttpCode(200)
  async rotate(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("endpointId") endpointId: string,
  ): Promise<RotateWebhookSecretResult> {
    try {
      return await this.service.rotateSecret(
        requiredTenantId(request),
        endpointId,
      );
    } catch (error: unknown) {
      throw mapBindingError(error, request.url);
    }
  }
}

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined || tenantId === null) {
    throw new HttpException(
      { detail: "Missing authenticated tenant context" },
      500,
    );
  }
  return tenantId;
}

function requiredWorkspaceId(request: IdentityTenantGatewayRequest): string {
  const workspaceId = request.actorContext?.workspace_id;
  if (workspaceId === undefined || workspaceId === null) {
    throw new HttpException(
      { detail: "Workspace-scoped actor context is required" },
      403,
    );
  }
  return workspaceId;
}
