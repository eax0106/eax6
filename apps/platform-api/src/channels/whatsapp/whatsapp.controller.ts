import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Idempotent } from "../../idempotency";
import { ActorContext, RequirePermission, RequireWorkspaceRole, type ActorContextType } from "../../rbac";
import type { EngineCallerContext } from "../../engine";
import { WhatsappService, type CreateWhatsappAccountInput } from "./whatsapp.service";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;

@Controller("/api/v1/channels/whatsapp")
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Post("accounts") @HttpCode(201) @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  register(@Body() body: CreateWhatsappAccountInput, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    return this.whatsapp.register(body, context(requireActor(actor), traceparent), idempotencyKey!);
  }

  @Get("accounts") @RequireWorkspaceRole(...readRoles) @RequirePermission("integrations:read")
  list(@ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined) {
    return this.whatsapp.list(context(requireActor(actor), traceparent));
  }

  @Delete("accounts/:id") @HttpCode(204) @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  remove(@Param("id") id: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    return this.whatsapp.remove(id, context(requireActor(actor), traceparent), idempotencyKey!);
  }

  @Get("accounts/:id/templates") @RequireWorkspaceRole(...readRoles) @RequirePermission("integrations:read")
  templates(@Param("id") id: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined) {
    return this.whatsapp.templates(id, context(requireActor(actor), traceparent));
  }

  @Post("accounts/:id/test-send") @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  testSend(@Param("id") id: string, @Body() body: { readonly to: string; readonly templateName: string; readonly languageCode?: string }, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined) {
    return this.whatsapp.testSend(id, body.to, body.templateName, body.languageCode, context(requireActor(actor), traceparent));
  }

  @Get("accounts/:id/health") @RequireWorkspaceRole(...readRoles) @RequirePermission("integrations:read")
  health(@Param("id") id: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined) {
    return this.whatsapp.health(id, context(requireActor(actor), traceparent));
  }

  @Patch("accounts/:id/monitoring") @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  monitoring(@Param("id") id: string, @Body() monitoringConfig: Readonly<Record<string, unknown>>, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    return this.whatsapp.updateConfiguration(id, { monitoringConfig }, context(requireActor(actor), traceparent), idempotencyKey!);
  }

  @Patch("accounts/:id/media") @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  media(@Param("id") id: string, @Body() mediaConfig: Readonly<Record<string, unknown>>, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    return this.whatsapp.updateConfiguration(id, { mediaConfig }, context(requireActor(actor), traceparent), idempotencyKey!);
  }

  @Get("accounts/:id/escalations") @RequireWorkspaceRole(...readRoles) @RequirePermission("integrations:read")
  async escalations(@Param("id") id: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined) {
    return (await this.whatsapp.list(context(requireActor(actor), traceparent))).find((account) => account.id === id)?.escalationRules ?? [];
  }

  @Post("accounts/:id/escalations") @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  async createEscalation(@Param("id") id: string, @Body() rule: Readonly<Record<string, unknown>>, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    const caller = context(requireActor(actor), traceparent); const account = (await this.whatsapp.list(caller)).find((item) => item.id === id); if (!account) throw new UnauthorizedException("WhatsApp account not found");
    const escalationRule = { ...rule, id: `wer_${randomBytes(12).toString("hex")}` };
    return this.whatsapp.updateConfiguration(id, { escalationRules: [...(account.escalationRules ?? []), escalationRule] }, caller, idempotencyKey!);
  }

  @Patch("accounts/:id/escalations/:ruleId") @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  async updateEscalation(@Param("id") id: string, @Param("ruleId") ruleId: string, @Body() rule: Readonly<Record<string, unknown>>, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    const caller = context(requireActor(actor), traceparent); const account = (await this.whatsapp.list(caller)).find((item) => item.id === id); if (!account) throw new UnauthorizedException("WhatsApp account not found");
    return this.whatsapp.updateConfiguration(id, { escalationRules: (account.escalationRules ?? []).map((item) => item.id === ruleId ? { ...item, ...rule, id: ruleId } : item) }, caller, idempotencyKey!);
  }

  @Delete("accounts/:id/escalations/:ruleId") @RequireWorkspaceRole(...writeRoles) @RequirePermission("integrations:write") @Idempotent()
  async deleteEscalation(@Param("id") id: string, @Param("ruleId") ruleId: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined) {
    const caller = context(requireActor(actor), traceparent); const account = (await this.whatsapp.list(caller)).find((item) => item.id === id); if (!account) throw new UnauthorizedException("WhatsApp account not found");
    return this.whatsapp.updateConfiguration(id, { escalationRules: (account.escalationRules ?? []).filter((item) => item.id !== ruleId) }, caller, idempotencyKey!);
  }
}

function requireActor(actor: ActorContextType | undefined): ActorContextType { if (!actor) throw new UnauthorizedException("Authenticated actor required"); return actor; }
function context(actor: ActorContextType, traceparent: string | undefined): EngineCallerContext {
  if (!actor.workspace_id) throw new UnauthorizedException("Workspace actor context required");
  return { userId: actor.user_id, tenantId: actor.tenant_id, workspaceId: actor.workspace_id, sessionId: actor.session_id, authTime: actor.auth_time ?? Math.floor(Date.now() / 1_000), roles: actor.roles, permissions: actor.permissions, traceparent: traceparent ?? `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01` };
}
