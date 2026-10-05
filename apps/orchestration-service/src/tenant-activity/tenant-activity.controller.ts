import { Controller, Get, HttpException, Inject, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { TenantActivityWindowSchema } from "@alterx/contracts";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { RUN_LEARNING_AUDIT } from "../runs/run-learning.controller";
import { TenantActivityService } from "./tenant-activity.service";

@Controller("internal/tenant-activity")
export class TenantActivityController {
  constructor(private readonly activity: TenantActivityService, @Inject(RUN_LEARNING_AUDIT) private readonly audit: AuditEventHandler) {}

  @Get()
  async read(@Req() request: IdentityTenantGatewayRequest, @Query() query: unknown) {
    const actor = request.actorContext;
    if (actor?.actor_type !== "service") throw new HttpException("Service caller required", 403);
    const input = TenantActivityWindowSchema.safeParse(query);
    if (!input.success) throw new HttpException("Invalid tenant activity window", 400);
    const result = await this.activity.activity(input.data);
    await this.audit.recordEvent({ tenant_id: input.data.tenant_id, actor_type: "service", actor_ref: `service:${actor.tenant_id}`,
      action: "tenant.activity.read", target_type: "tenant", target_ref: input.data.tenant_id, result: "success", reason_code: "",
      context_json: JSON.stringify({ scope: "tenant_asserted_by_service" }), occurred_at: new Date().toISOString(),
    });
    return result;
  }
}
