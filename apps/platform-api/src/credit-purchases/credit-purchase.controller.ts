import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res, UseFilters } from "@nestjs/common";
import { TenantIdSchema, UserIdSchema } from "@alterx/contracts";
import type { FastifyReply } from "fastify";
import { ActorContext, RequirePermission, RequireTenantRole, type ActorContextType } from "../rbac";
import { BillingExceptionFilter } from "../billing/billing-exception.filter";
import { CreditPurchaseService, etag } from "./credit-purchase.service";
import { problem } from "./credit-purchase.repository";

@Controller("/api/v1/billing/credit-purchases")
@UseFilters(BillingExceptionFilter)
export class CreditPurchaseController {
  constructor(private readonly purchases: CreditPurchaseService) {}

  @Post()
  @HttpCode(201)
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  async create(@Body() body: unknown, @Headers("idempotency-key") key: string | undefined,
    @ActorContext() actor: ActorContextType, @Res({ passthrough: true }) response: FastifyReply) {
    const caller = subject(actor);
    const purchase = await this.purchases.create(caller.tenant, caller.user, body, key);
    response.header("ETag", etag(purchase)); return purchase;
  }

  @Get()
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  list(@ActorContext() actor: ActorContextType) {
    const caller = subject(actor); return this.purchases.list(caller.tenant, caller.user);
  }

  @Get(":id")
  @RequireTenantRole("admin")
  @RequirePermission("billing:read")
  async get(@Param("id") id: string, @ActorContext() actor: ActorContextType,
    @Res({ passthrough: true }) response: FastifyReply) {
    const caller = subject(actor); const purchase = await this.purchases.get(caller.tenant, caller.user, id);
    response.header("ETag", etag(purchase)); return purchase;
  }

  @Post(":id/refresh")
  @HttpCode(200)
  @RequireTenantRole("owner")
  @RequirePermission("billing:write")
  async refresh(@Param("id") id: string, @Body() body: unknown, @Headers("if-match") ifMatch: string | undefined,
    @ActorContext() actor: ActorContextType, @Res({ passthrough: true }) response: FastifyReply) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw problem(400, "INVALID_CREDIT_PURCHASE_REFRESH", "Refresh requires an empty object");
    }
    const caller = subject(actor); const purchase = await this.purchases.refresh(caller.tenant, caller.user, id, ifMatch);
    response.header("ETag", etag(purchase)); return purchase;
  }
}

function subject(actor: ActorContextType): { tenant: string; user: string } {
  const tenant = TenantIdSchema.safeParse(actor.tenant_id.startsWith("ten_") ? actor.tenant_id : `ten_${actor.tenant_id}`);
  const user = UserIdSchema.safeParse(actor.user_id.startsWith("usr_") ? actor.user_id : `usr_${actor.user_id}`);
  if (!tenant.success || !user.success) throw problem(403, "CREDIT_PURCHASE_FORBIDDEN", "Current tenant billing authorization is required");
  return { tenant: tenant.data, user: user.data };
}
