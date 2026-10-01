import { timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpException, Inject, Post } from "@nestjs/common";
import { Public } from "@alterx/auth";
import { SES_DELIVERY_ENVIRONMENT, type SesDeliveryEnvironment } from "../config/ses-delivery-environment";
import { parseSesDeliveryEvent, SesDeliveryEventsService } from "./ses-delivery-events.service";

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
    try {
      return await this.service.handle(parseSesDeliveryEvent(body));
    } catch (error: unknown) {
      throw new HttpException({ status: 400, error_code: "SES_WEBHOOK_INVALID", detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
