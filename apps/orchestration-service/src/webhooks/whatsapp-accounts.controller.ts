import { Body, Controller, Get, HttpException, Param, Post, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import { TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import type { WhatsappAccount } from "./whatsapp-account-registry.service";
import { WhatsappAccountRegistryService } from "./whatsapp-account-registry.service";

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
  async register(@Req() request: SessionGatewayRequest, @Body() body: RegisterAccountBody): Promise<WhatsappAccount> {
    const tenantId = requiredTenantId(request);
    if (!body.workspaceId || !body.phoneNumberId || !body.wabaId || !body.accessTokenRef) {
      throw new HttpException("workspaceId, phoneNumberId, wabaId, and accessTokenRef are required", 400);
    }
    // platform-api's actor context carries the bare workspace UUID; a
    // prefixed id is accepted too.
    const workspaceId = WorkspaceIdSchema.safeParse(
      body.workspaceId.startsWith("ws_") ? body.workspaceId : `ws_${body.workspaceId}`,
    );
    if (!workspaceId.success) throw new HttpException("workspaceId must be a workspace UUIDv7", 400);
    return toApi(await this.registry.register(tenantId, {
      workspaceId: workspaceId.data.slice("ws_".length),
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
  async list(@Req() request: SessionGatewayRequest): Promise<{ readonly accounts: readonly WhatsappAccount[] }> {
    return { accounts: (await this.registry.list(requiredTenantId(request))).map(toApi) };
  }

  @Post(":id/configuration")
  async updateConfiguration(
    @Req() request: SessionGatewayRequest,
    @Param("id") accountId: string,
    @Body() body: {
      readonly monitoringConfig?: Readonly<Record<string, unknown>>;
      readonly mediaConfig?: Readonly<Record<string, unknown>>;
      readonly escalationRules?: readonly Readonly<Record<string, unknown>>[];
    },
  ): Promise<WhatsappAccount> {
    return toApi(await this.registry.updateConfiguration(requiredTenantId(request), accountId, body));
  }
}

// The registry works in database form (bare UUIDs); the API speaks prefixed
// ids like every other route, and platform-api compares an account's
// workspaceId with the caller's ws_ id before any by-id operation.
function requiredTenantId(request: SessionGatewayRequest): string {
  const tenantId = TenantIdSchema.safeParse(request.actorContext?.tenant_id);
  if (!tenantId.success) throw new HttpException("Missing authenticated tenant context", 500);
  return tenantId.data.slice("ten_".length);
}

function toApi(account: WhatsappAccount): WhatsappAccount {
  return { ...account, tenantId: `ten_${account.tenantId}`, workspaceId: `ws_${account.workspaceId}` };
}
