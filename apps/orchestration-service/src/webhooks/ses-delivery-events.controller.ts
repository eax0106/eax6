import { timingSafeEqual } from "node:crypto";
import { Body, Controller, Get, Headers, HttpException, Inject, Post, Query, Req } from "@nestjs/common";
import { Public, type SessionGatewayRequest } from "@alterx/auth";
import { SES_DELIVERY_ENVIRONMENT, type SesDeliveryEnvironment } from "../config/ses-delivery-environment";
import { EmailReadbackPendingError, parseSesDeliveryEvent, SesDeliveryEventsService } from "./ses-delivery-events.service";

@Controller("v1/webhooks/ses")
export class SesDeliveryEventsController {
  constructor(
    private readonly service: SesDeliveryEventsService,
    @Inject(SES_DELIVERY_ENVIRONMENT)
    private readonly config: SesDeliveryEnvironment,
  ) {}

  @Post()
  @Public()
  async receive(@Headers("x-alter-ses-secret") secret: string | undefined, @Body() body: unknown) {
    const expected = this.config.webhookSecret;
    if (expected === undefined || secret === undefined || !sameSecret(secret, expected)) {
      throw new HttpException({ status: 401, error_code: "SES_WEBHOOK_UNAUTHORIZED", detail: "SES webhook secret is invalid" }, 401);
    }
    let event: ReturnType<typeof parseSesDeliveryEvent>;
    try { event = parseSesDeliveryEvent(body); } catch {
      throw new HttpException({ status: 400, error_code: "SES_WEBHOOK_INVALID", detail: "Invalid SES delivery event" }, 400);
    }
    try { return await this.service.handle(event); } catch (error: unknown) {
      if (error instanceof EmailReadbackPendingError) {
        throw new HttpException({ status: 503, error_code: "SES_READBACK_PENDING", detail: "Retry after accepted email is recorded" }, 503);
      }
      throw error;
    }
  }
}

@Controller("api/v1/email-delivery-failures")
export class EmailDeliveryFailuresController {
  constructor(private readonly service: SesDeliveryEventsService) {}

  @Get()
  async list(@Req() request: SessionGatewayRequest, @Query("cursor") cursor?: string) {
    if (cursor !== undefined && cursor.length > 250) throw new HttpException("Invalid cursor", 400);
    return this.service.failures(this.systemTenant(request), cursor);
  }

  private systemTenant(request: SessionGatewayRequest): string {
    if (request.actorContext?.actor_type !== "system") {
      throw new HttpException({ status: 403, error_code: "EMAIL_DELIVERY_SYSTEM_ONLY", detail: "This feed is for platform background jobs" }, 403);
    }
    return request.actorContext.tenant_id;
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
