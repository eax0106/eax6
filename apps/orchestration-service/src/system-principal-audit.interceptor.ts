import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { tap, type Observable } from "rxjs";

/**
 * Every request made by the system principal (D1, `system:platform-jobs`) is
 * audited with its principal type: what a background job read, for which
 * tenant, and whether it worked. Route pattern only, never the query string or
 * a payload. Audit writes fail open with a loud log (planes 38): they never
 * block the read they describe, the same rule C46 follows for service-asserted
 * tenants.
 */
@Injectable()
export class SystemPrincipalAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SystemPrincipalAuditInterceptor.name);

  constructor(private readonly audit: AuditEventHandler) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<
      IdentityTenantGatewayRequest & { routeOptions?: { url?: string } }
    >();
    const actor = request.actorContext;
    if (actor?.actor_type !== "system") return next.handle();

    const target = `${request.method ?? "GET"} ${
      request.routeOptions?.url ?? (request.url ?? "").split("?")[0]
    }`;
    return next.handle().pipe(
      tap({
        complete: () => void this.#record(actor.tenant_id, actor.jti, target, "success"),
        error: () => void this.#record(actor.tenant_id, actor.jti, target, "error"),
      }),
    );
  }

  async #record(
    tenantId: string,
    jti: string | null,
    target: string,
    result: "success" | "error",
  ): Promise<void> {
    try {
      await this.audit.recordEvent({
        tenant_id: tenantId,
        actor_type: "system",
        actor_ref: "system:platform-jobs",
        action: "system.read",
        target_type: "route",
        target_ref: target,
        result,
        reason_code: "",
        // audit-service accepts only ip_class, request_id and scope as context
        // keys; the principal type is the event's own actor_type.
        context_json: JSON.stringify({ scope: "system_read", request_id: jti ?? "" }),
        occurred_at: new Date().toISOString(),
      });
    } catch (error: unknown) {
      this.logger.error({
        message: "system principal audit write failed",
        tenantId,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
