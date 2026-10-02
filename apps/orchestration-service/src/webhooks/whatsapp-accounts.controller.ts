import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import type { WhatsappAccount } from "./whatsapp-account-registry.service";
import { WhatsappAccountNotFoundError, WhatsappAccountRegistryService } from "./whatsapp-account-registry.service";

interface RegisterAccountBody {
  readonly workspaceId: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly accessTokenRef: string;
  readonly status?: "connected" | "disconnected";
  readonly monitoringConfig?: Readonly<Record<string, unknown>>;
  readonly mediaConfig?: Readonly<Record<string, unknown>>;
  readonly escalationRules?: readonly Readonly<Record<string, unknown>>[];
}

@Controller("api/v1/channels/whatsapp/accounts")
export class WhatsappAccountsController {
  constructor(private readonly registry: WhatsappAccountRegistryService) {}

  @Post()
  async register(@Req() request: IdentityTenantGatewayRequest, @Body() body: RegisterAccountBody): Promise<WhatsappAccount> {
    const tenantId = requiredTenantId(request);
    if (typeof body.workspaceId !== "string" || !body.workspaceId || !body.phoneNumberId || !body.wabaId || !body.accessTokenRef) {
      throw new HttpException("workspaceId, phoneNumberId, wabaId, and accessTokenRef are required", 400);
    }
    // platform-api's actor context carries the bare workspace UUID; a
    // prefixed id is accepted too.
    const workspaceId = WorkspaceIdSchema.safeParse(
      body.workspaceId.startsWith("ws_") ? body.workspaceId : `ws_${body.workspaceId}`,
    );
    if (!workspaceId.success) throw new HttpException("workspaceId must be a workspace UUIDv7", 400);
    const callerWorkspaceId = requiredWorkspaceId(request);
    if (workspaceId.data.slice("ws_".length) !== callerWorkspaceId) {
      throw new HttpException("Account workspace must match the authenticated workspace", 403);
    }
    return toApi(await this.registry.register(tenantId, {
      workspaceId: callerWorkspaceId,
      phoneNumberId: body.phoneNumberId,
      wabaId: body.wabaId,
      accessTokenRef: body.accessTokenRef,
      status: body.status ?? "connected",
      monitoringConfig: body.monitoringConfig ?? {},
      mediaConfig: body.mediaConfig ?? {},
      escalationRules: body.escalationRules ?? [],
    }));
  }

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest): Promise<{ readonly accounts: readonly WhatsappAccount[] }> {
    return { accounts: (await this.registry.list(requiredTenantId(request), requiredWorkspaceId(request))).map(toApi) };
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() request: IdentityTenantGatewayRequest, @Param("id") accountId: string): Promise<void> {
    try {
      await this.registry.remove(requiredTenantId(request), requiredWorkspaceId(request), accountId);
    } catch (error: unknown) {
      if (error instanceof WhatsappAccountNotFoundError) throw new HttpException("WhatsApp account not found", 404);
      throw error;
    }
  }

  @Post(":id/configuration")
  async updateConfiguration(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") accountId: string,
    @Body() body: {
      readonly monitoringConfig?: Readonly<Record<string, unknown>>;
      readonly mediaConfig?: Readonly<Record<string, unknown>>;
      readonly escalationRules?: readonly Readonly<Record<string, unknown>>[];
    },
  ): Promise<WhatsappAccount> {
    try {
      return toApi(await this.registry.updateConfiguration(requiredTenantId(request), requiredWorkspaceId(request), accountId, body));
    } catch (error: unknown) {
      if (error instanceof WhatsappAccountNotFoundError) throw new HttpException("WhatsApp account not found", 404);
      throw error;
    }
  }
}

// The registry works in database form (bare UUIDs); the API speaks prefixed
// ids like every other route, and platform-api compares an account's
// workspaceId with the caller's ws_ id before any by-id operation.
function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = TenantIdSchema.safeParse(request.actorContext?.tenant_id);
  if (!tenantId.success) throw new HttpException("Missing authenticated tenant context", 500);
  return tenantId.data.slice("ten_".length);
}

function requiredWorkspaceId(request: IdentityTenantGatewayRequest): string {
  const workspaceId = WorkspaceIdSchema.safeParse(request.actorContext?.workspace_id);
  if (!workspaceId.success) throw new HttpException("Missing authenticated workspace context", 500);
  return workspaceId.data.slice("ws_".length);
}

function toApi(account: WhatsappAccount): WhatsappAccount {
  return { ...account, tenantId: `ten_${account.tenantId}`, workspaceId: `ws_${account.workspaceId}` };
}
