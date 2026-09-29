import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { MetaCloudApiWhatsappProvider } from "@alterx/adapters";
import type { JsonValue, SecretsProvider } from "@alterx/shared-clients";
import { EngineClient, type EngineCallerContext } from "../../engine";
import { secretsProviderToken } from "../../identity-broker/identity-broker.module";

export interface WhatsappAccount {
  readonly id: string;
  readonly workspaceId: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly accessTokenRef: string;
  readonly status: "connected" | "disconnected";
  readonly monitoringConfig?: Readonly<Record<string, unknown>>;
  readonly mediaConfig?: Readonly<Record<string, unknown>>;
  readonly escalationRules?: readonly Readonly<Record<string, unknown>>[];
}

export interface CreateWhatsappAccountInput {
  readonly workspaceId: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly accessTokenRef: string;
}

@Injectable()
export class WhatsappService {
  private readonly provider: MetaCloudApiWhatsappProvider;

  constructor(
    private readonly engine: EngineClient,
    @Inject(secretsProviderToken) secrets: SecretsProvider,
  ) {
    this.provider = new MetaCloudApiWhatsappProvider(secrets);
  }

  async register(
    input: CreateWhatsappAccountInput,
    context: EngineCallerContext,
    idempotencyKey: string,
  ): Promise<WhatsappAccount> {
    const response = await this.engine.post<JsonValue, WhatsappAccount>(
      "/api/v1/channels/whatsapp/accounts",
      input as unknown as JsonValue,
      context,
      { idempotencyKey },
    );
    if (!response.body) throw new Error("Engine returned an empty WhatsApp account response");
    return response.body;
  }

  async list(context: EngineCallerContext): Promise<readonly WhatsappAccount[]> {
    const response = await this.engine.get<{ readonly accounts: readonly WhatsappAccount[] }>(
      "/api/v1/channels/whatsapp/accounts",
      context,
    );
    return response.body?.accounts ?? [];
  }

  async templates(accountId: string, context: EngineCallerContext) {
    return this.provider.getTemplates(await this.account(accountId, context));
  }

  async testSend(
    accountId: string,
    to: string,
    templateName: string,
    languageCode: string | undefined,
    context: EngineCallerContext,
  ) {
    return this.provider.sendTemplateMessage(
      await this.account(accountId, context), to, templateName, languageCode,
    );
  }

  async health(accountId: string, context: EngineCallerContext) {
    return this.provider.getAccountHealth(await this.account(accountId, context));
  }

  async updateConfiguration(
    accountId: string,
    configuration: Readonly<Record<string, unknown>>,
    context: EngineCallerContext,
    idempotencyKey: string,
  ): Promise<WhatsappAccount> {
    await this.account(accountId, context);
    const response = await this.engine.post<JsonValue, WhatsappAccount>(
      `/api/v1/channels/whatsapp/accounts/${encodeURIComponent(accountId)}/configuration`,
      configuration as JsonValue,
      context,
      { idempotencyKey },
    );
    if (!response.body) throw new Error("Engine returned an empty WhatsApp account response");
    return response.body;
  }

  // Confirms accountId belongs to the caller's own workspace before any
  // by-id operation touches it -- defense in depth. list() already asks Engine
  // with the caller's own tenantId/workspaceId, but that alone means
  // trusting Engine's list endpoint to have actually scoped by workspace
  // (not just tenant), a blind-trust gap. Re-checking the resolved account's workspaceId locally
  // means a Engine list that only scopes by tenant (or regresses to that)
  // can't leak a cross-workspace account through this path either.
  private async account(accountId: string, context: EngineCallerContext): Promise<WhatsappAccount> {
    const account = (await this.list(context)).find((item) => item.id === accountId);
    // The engine answers with ws_ ids; the actor context holds the bare UUID.
    if (!account || bareWorkspace(account.workspaceId) !== bareWorkspace(context.workspaceId)) {
      throw new NotFoundException("WhatsApp account not found");
    }
    return account;
  }
}

function bareWorkspace(workspaceId: string): string {
  return workspaceId.startsWith("ws_") ? workspaceId.slice("ws_".length) : workspaceId;
}
